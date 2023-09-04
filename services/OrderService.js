import mongoose from 'mongoose';
import Product from '../models/product.model.js';
import Order from '../models/order.model.js';
import Variant from '../models/variant.model.js';
import Cart from '../models/cart.model.js';
import DiscountCode from '../models/discountCode.model.js';
import User from '../models/user.model.js';
import { orderQueryParams, validateConstants } from '../utils/searchConstants.js';
import { validationResult } from 'express-validator';
import { createCheckStatusBody, createPaymentBody, createRefundTransBody } from '../utils/payment-with-momo.js';
import axios from 'axios';
import Payment from '../models/payment.model.js';
import { v4 as uuidv4 } from 'uuid';
import { momo_Request, GHN_Request } from '../utils/request.js';
import Delivery from '../models/delivery.model.js';
import statusResponseFalse from '../utils/messageMoMo.js';
import crypto from 'crypto';
import { MAX_MINUTES_WAITING_TO_PAY, MAX_DAYS_WAITING_FOR_SHOP_CONFIRMATION } from '../utils/orderConstants.js';
import {
    PAYMENT_WITH_CASH,
    PAYMENT_WITH_MOMO,
    PAYMENT_WITH_ATM,
    PAYMENT_WITH_CREDIT_CARD,
} from '../utils/paymentConstants.js';
import TaskService from '../services/TaskService.js';
import {
    ItemNotFoundError,
    InvalidDataError,
    UnauthenticatedError,
    InternalServerError,
    UnprocessableContentError,
} from '../utils/errors.js';

//CONSTANT
const TYPE_DISCOUNT_MONEY = 1;
const TYPE_DISCOUNT_PERCENT = 2;

const PAYMENT_DEFAULT_ORDER_INFO = 'Thanh toán đơn hàng tại BlueShop';

const getOrdersByUserId = async (req, res) => {
    // Validate the request data using express-validator
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const message = errors.array()[0].msg;
        throw new InvalidDataError(message);
    }
    if (req.user.role !== 'staff' && req.user.role !== 'admin') {
        if (req.user._id != req.params.userId) {
            throw new UnauthenticatedError('Bị cấm. Bạn không thể truy cập thông tin đơn hàng của người khác.');
        }
    }
    const limit = Number(req.query.limit) || 20; //EDIT HERE
    const page = Number(req.query.page) || 0;
    const status = String(req.query.status) || null;
    const orderFilter = { user: req.user._id };
    if (status) {
        orderFilter.status = status;
    }
    const count = await Order.countDocuments({ ...orderFilter });
    const orders = await Order.find({ ...orderFilter })
        .populate(['delivery', 'paymentInformation'])
        .limit(limit)
        .skip(limit * page)
        .sort({ createdAt: 'desc' })
        .lean();
    res.json({ data: { orders, page, pages: Math.ceil(count / limit), total: count } });
};

const getOrderById = async (req, res) => {
    // Validate the request data using express-validator
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const message = errors.array()[0].msg;
        throw new InvalidDataError(message);
    }
    const order = await Order.findOne({ _id: req.params.id }).populate(['delivery', 'paymentInformation']).lean();
    if (!order) {
        throw new ItemNotFoundError('Đơn hàng không tồn tại');
    }
    if (req.user.role !== 'staff' && req.user.role !== 'admin') {
        if (req.user._id.toString() !== order.user.toString()) {
            throw new ItemNotFoundError('Đơn hàng không tồn tại');
        }
    }
    res.json({ data: { order } });
};

const getOrders = async (req, res) => {
    const limit = Number(req.query.limit) || 20; //EDIT HERE
    const page = Number(req.query.page) || 0;
    const sortBy = validateConstants(orderQueryParams, 'sort', req.query.sortBy);
    const orderStatusFilter = validateConstants(orderQueryParams, 'status', req.query.status);
    const orderFilter = {
        ...orderStatusFilter,
    };
    const count = await Order.countDocuments(orderFilter);
    const orders = await Order.find({ ...orderFilter })
        .populate(['delivery', 'paymentInformation'])
        .limit(limit)
        .skip(limit * page)
        .sort({ ...sortBy })
        .lean();
    res.json({ data: { orders, page, pages: Math.ceil(count / limit), total: count } });
};

const checkOrderProductList = async (size, orderItems) => {
    const result = {
        // error: 0,
        // message: '',
        orderItemIds: [],
        orderedProductList: [],
        totalProductPrice: 0,
    };
    await Promise.all(
        orderItems.map(async (orderItem) => {
            const orderedVariant = await Variant.findOne({
                _id: orderItem.variant,
                disabled: false,
                deleted: false,
            }).populate('product');
            if (!orderedVariant || !orderedVariant.product?._id) {
                throw new Error(`Sản phẩm "${orderItem.name ? orderItem.name : orderItem.variant}" không tồn tại`);
            }
            if (orderedVariant.quantity < orderItem.quantity) {
                throw new Error(
                    `Số lượng đặt hàng của sản phẩm "${orderedVariant.product.name}" vượt quá số lượng trong kho`,
                );
            }
            size.height += orderedVariant.product.height * orderItem.quantity;
            size.weight += orderedVariant.product.weight * orderItem.quantity;
            size.length += orderedVariant.product.length;
            size.width += orderedVariant.product.width;
            result.totalProductPrice += orderedVariant.priceSale * orderItem.quantity;
            result.orderItemIds.push(orderItem.variant);
            result.orderedProductList.push({
                _id: orderedVariant.product._id,
                priceSale: orderedVariant.priceSale,
                quantity: orderItem.quantity,
            });
        }),
    );
    // .catch((error) => {
    //     result.error = 1;
    //     result.message = error.message;
    //     result.orderItemIds = [];
    // });
    //temp
    // size.height = 5;
    // size.length = 5;
    // size.width = 5;
    return result;
};

const calculateFee = async (shippingAddress, size, price) => {
    // const deliveryFee = {
    //     fee: 0,
    //     error: 0,
    //     status: 200,
    //     message: '',
    // };
    if (size.weight == 0) {
        size.weight = 1;
    }
    const config = {
        data: JSON.stringify({
            shop_id: Number(process.env.GHN_SHOP_ID),
            service_id: Number(shippingAddress.service_id),
            to_district_id: Number(shippingAddress.to_district_id),
            to_ward_code: String(shippingAddress.to_ward_code),
            height: size.height,
            length: size.length,
            weight: size.weight,
            width: size.width,
            insurance_value: price,
        }),
    };
    await GHN_Request.get('v2/shipping-order/fee', config)
        .then((response) => {
            // deliveryFee = response.data.data.total;
            return response.data.data.total;
        })
        .catch((error) => {
            throw new InternalServerError(error.response.data.message || error.message || '');
            // deliveryFee.error = 1;
            // deliveryFee.status = error.response.data.code || 500;
            // deliveryFee.message = error.response.data.message || error.message || '';
        });
};

const estimatedDeliveryTime = async (shippingAddress) => {
    // const result = {
    //     leadTime: null,
    //     error: 0,
    //     status: 200,
    //     message: '',
    // };
    const config = {
        data: JSON.stringify({
            shop_id: Number(process.env.GHN_SHOP_ID),
            service_id: Number(shippingAddress.service_id),
            to_district_id: Number(shippingAddress.to_district_id),
            to_ward_code: String(shippingAddress.to_ward_code),
        }),
    };
    await GHN_Request.get('v2/shipping-order/leadtime', config)
        .then((response) => {
            return response.data.data.leadtime;
        })
        .catch((error) => {
            throw new InternalServerError(error.response.data.message || error.message || '');
            // result.error = 1;
            // result.status = error.response.data.code || 500;
            // result.message = error.response.data.message || error.message || '';
        });
};

const getAddressName = async (shippingAddress) => {
    const address = {
        ...shippingAddress,
        provinceName: '',
        districtName: '',
        wardName: '',
    };
    // const result = {
    //     error: 0,
    //     status: 200,
    //     message: '',
    //     address: {
    //         ...shippingAddress,
    //         provinceName: '',
    //         districtName: '',
    //         wardName: '',
    //     },
    // };
    // Get province
    await GHN_Request.get('/master-data/province')
        .then((response) => {
            const provinces = response.data.data;
            provinces.map((item) => {
                if (item.ProvinceID == shippingAddress.to_province_id) {
                    address.provinceName = item.ProvinceName;
                }
            });
        })
        .catch((error) => {
            // result.status = error.response.data.code || 500;
            throw new InternalServerError(error.response.data.message || error.message || '');
        });

    //Get district
    await GHN_Request.get('/master-data/district', {
        data: JSON.stringify({
            province_id: shippingAddress.to_province_id,
        }),
    })
        .then((response) => {
            const districts = response.data.data;
            districts.map((item) => {
                if (item.DistrictID == shippingAddress.to_district_id) {
                    address.districtName = item.DistrictName;
                }
            });
        })
        .catch((error) => {
            // result.status = error.response.data.code || 500;
            throw new InternalServerError(error.response.data.message || error.message || '');
        });
    //Get ward
    await GHN_Request.get('/master-data/ward', {
        data: JSON.stringify({
            district_id: shippingAddress.to_district_id,
        }),
    })
        .then((response) => {
            const wards = response.data.data;
            wards.map((item) => {
                if (item.WardCode == shippingAddress.to_ward_code) {
                    address.wardName = item.WardName;
                }
            });
        })
        .catch((error) => {
            // result.status = error.response.data.code || 500;
            throw new InternalServerError(error.response.data.message || error.message || '');
        });
    if (!address.provinceName) {
        throw new InvalidDataError('Tỉnh/Thành phố không hợp lệ');
    }
    if (!address.districtName) {
        throw new InvalidDataError('Quận/Huyện không hợp lệ');
    }
    if (!address.wardName) {
        throw new InvalidDataError('Xã/Phường không hợp lệ');
    }
    return address;
    // catch (error) {
    //     result.error = 1;
    //     result.message = error.message;
    //     return result;
    // }
};

const createOrder = async (req, res, next) => {
    // Validate the request data using express-validator
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const message = errors.array()[0].msg;
        throw new InvalidDataError(message);
    }
    const user = await User.findOne({ _id: req.user._id });

    const { shippingAddress, paymentMethod, orderItems, discountCode, note } = req.body;

    const size = {
        height: 0,
        weight: 0,
        length: 0,
        width: 0,
    };
    const productCheckResult = await checkOrderProductList(size, orderItems);
    if (productCheckResult.error) {
        throw new InvalidDataError(productCheckResult.message);
    }

    const calculateDeliveryFee = calculateFee(shippingAddress, size, productCheckResult.totalProductPrice);
    const calculateLeadTime = estimatedDeliveryTime(shippingAddress);
    const getAddress = getAddressName(shippingAddress);
    const [deliveryFee, leadTime, address] = await Promise.all([calculateDeliveryFee, calculateLeadTime, getAddress]);
    // if (deliveryFee.error) {
    //     res.status(deliveryFee.status);
    //     throw new Error(deliveryFee.message);
    // }
    // if (leadTime.error) {
    //     res.status(leadTime.status);
    //     throw new Error(leadTime.message);
    // }
    // if (addressResult.error) {
    //     res.status(addressResult.status);
    //     throw new Error(addressResult.message);
    // }

    const session = await mongoose.startSession();
    const transactionOptions = {
        readPreference: 'primary',
        readConcern: { level: 'local' },
        writeConcern: { w: 'majority' },
    };

    try {
        await session.withTransaction(async () => {
            // const newOrderItems = await createOrderItems(session, orderItems);
            const dataOrderItem = [];
            const createOrderItems = orderItems.map(async (orderItem) => {
                const orderedVariant = await Variant.findOneAndUpdate(
                    {
                        _id: orderItem.variant,
                        quantity: { $gte: orderItem.quantity },
                        disabled: false,
                        deleted: false,
                    },
                    { $inc: { quantity: -orderItem.quantity } },
                    { new: true },
                )
                    .session(session)
                    .lean();
                if (!orderedVariant) {
                    await session.abortTransaction();
                    throw new InvalidDataError(`Sản phẩm có ID "${orderItem.variant}" đã hết hàng`);
                }
                const orderedProduct = await Product.findOneAndUpdate(
                    { _id: orderedVariant.product, disabled: false, deleted: false },
                    { $inc: { totalSales: +orderItem.quantity, quantity: -orderItem.quantity } },
                )
                    .session(session)
                    .lean();
                // await Promise.all([orderedVariant, orderedProduct]);
                if (!orderedProduct) {
                    await session.abortTransaction();
                    throw new UnprocessableContentError(`Sản phẩm có ID "${orderItem.variant}" không tồn tại`);
                }

                const newOrderItem = {
                    product: orderedProduct._id,
                    name: orderedProduct.name,
                    attributes: orderedVariant.attributes,
                    image: orderedVariant.image || orderedProduct.images[0] || null,
                    price: orderedVariant.priceSale,
                    quantity: orderItem.quantity,
                };
                if (!newOrderItem.image) {
                    newOrderItem.image = orderedProduct.images[0] || null;
                }
                dataOrderItem.push(newOrderItem);
            });
            await Promise.all(createOrderItems);
            if (dataOrderItem.length < orderItems.length) {
                await session.abortTransaction();
                throw new InternalServerError('Xảy ra lỗi khi tạo đơn hàng, vui lòng làm mới trang và đặt hàng lại');
            }
            // create order information
            const orderInfor = new Order({
                orderItems: dataOrderItem,
                user: req.user._id,
                username: req.user.name,
                totalProductPrice: productCheckResult.totalProductPrice || 0,
                shippingPrice: deliveryFee,
                totalDiscount: 0,
                status: 'placed',
                statusHistory: { status: 'placed', updateBy: req.user._id },
            });

            //Check discount code
            if (discountCode) {
                const code = String(discountCode) || '';
                const discountCodeExist = await DiscountCode.findOne({ code: code, disabled: false });
                if (!discountCodeExist) {
                    await session.abortTransaction();
                    throw new UnprocessableContentError('Mã giảm giá không tồn tại');
                }
                if (discountCodeExist.startDate > new Date()) {
                    await session.abortTransaction();
                    throw new InvalidDataError(`Mã giảm giá có hiệu lực từ ngày ${Date(discountCode.startDate)}`);
                }
                if (discountCodeExist.endDate < new Date()) {
                    await session.abortTransaction();
                    throw new InvalidDataError('Mã giảm giá đã hết hạn');
                }
                if (discountCodeExist.isUsageLimit && discountCodeExist.usageLimit <= discountCodeExist.used) {
                    await session.abortTransaction();
                    throw new InvalidDataError('Mã giảm giá đã được sử dụng hết');
                }
                if (discountCodeExist.userUseMaximum > 1) {
                    const countUser = discountCodeExist.usedBy.filter((item) => {
                        return item.toString() == req.user._id.toString();
                    });
                    if (countUser.length >= discountCodeExist.userUseMaximum) {
                        await session.abortTransaction();
                        throw new InvalidDataError('Bạn đã hết lượt sử dụng mã giảm giá này');
                    }
                } else if (discountCodeExist.usedBy.includes(req.user._id)) {
                    await session.abortTransaction();
                    throw new InvalidDataError('Bạn đã hết lượt sử dụng mã giảm giá này');
                }
                // Tổng giá sản phẩm nằm trong danh sách được giảm giá của discount code
                let totalPriceProductDiscounted = 0;
                if (discountCodeExist.applyFor == 1) {
                    totalPriceProductDiscounted = productCheckResult.totalProductPrice;
                } else {
                    let count = 0;
                    productCheckResult.orderedProductList.map((item) => {
                        if (discountCodeExist.applicableProducts.includes(item._id)) {
                            totalPriceProductDiscounted += item.priceSale * item.quantity;
                            count++;
                        }
                    });
                    if (count == 0) {
                        await session.abortTransaction();
                        throw new InvalidDataError('Mã giảm giá không được áp dụng cho các sản phẩm này');
                    }
                }
                let discount;
                if (discountCodeExist.discountType == TYPE_DISCOUNT_MONEY) {
                    if (totalPriceProductDiscounted >= discountCodeExist.discount) {
                        discount = discountCodeExist.discount;
                    } else {
                        discount = totalPriceProductDiscounted;
                    }
                } else if (discountCodeExist.discountType == TYPE_DISCOUNT_PERCENT) {
                    discount = ((totalPriceProductDiscounted * discountCodeExist.discount) / 100).toFixed(3);
                    if (discount > discountCodeExist.maximumDiscount) {
                        discount = discountCodeExist.maximumDiscount;
                    }
                }
                discountCodeExist.usedBy.push(req.user._id);
                discountCodeExist.used++;
                await discountCodeExist.save({ session });

                orderInfor.totalDiscount = discount;
            }

            const totalPayment = orderInfor.totalProductPrice + deliveryFee - orderInfor.totalDiscount;

            if (totalPayment >= 0) {
                orderInfor.totalPayment = totalPayment;
            } else {
                orderInfor.totalPayment = 0;
            }
            let leadDateTime = new Date(leadTime * 1000);

            if (leadDateTime == 'Invalid Date') {
                leadDateTime = null;
            }

            const newShippingInfor = new Delivery({
                order: orderInfor._id,
                client: req.user._id,
                to_name: address.to_name,
                to_phone: address.to_phone,
                to_province_name: address.provinceName,
                to_district_name: address.districtName,
                to_ward_name: address.wardName,
                to_province_id: address.to_province_id,
                to_district_id: address.to_district_id,
                to_ward_code: address.to_ward_code,
                to_address: address.to_address,
                note: note || '',
                service_id: Number(shippingAddress.service_id),
                items: orderInfor.orderItems,
                deliveryFee: deliveryFee,
                leadTime: leadDateTime,
                height: size.height,
                length: size.length,
                weight: size.weight,
                width: size.width,
                insurance_value: orderInfor.totalProductPrice,
            });
            const newShipping = await newShippingInfor.save({ session });
            if (!newShipping) {
                await session.abortTransaction();
                throw new InternalServerError('Gặp lỗi khi tạo thông tin giao hàng');
            }
            orderInfor.delivery = newShipping._id;

            const newPaymentInformation = new Payment({
                user: req.user._id,
                order: orderInfor._id,
                paymentAmount: orderInfor.totalPayment,
            });
            newPaymentInformation.paymentMethod = paymentMethod;

            if (isMomoPaymentMethods(newPaymentInformation.paymentMethod)) {
                //Create payment information with momo
                const amount = Number(orderInfor.totalPayment).toFixed();
                // const redirectUrl = `${process.env.CLIENT_PAGE_URL}/order/${orderInfor._id}/waiting-payment`;
                // const ipnUrl = `${process.env.API_URL}/api/v1/orders/${orderInfor._id}/payment-notification`;
                const ipnUrl = `http://localhost:5000/api/v1/orders/${orderInfor._id}/payment-notification`;
                const redirectUrl = ipnUrl;
                const requestId = uuidv4();
                const requestBody = createPaymentBody(
                    orderInfor._id,
                    requestId,
                    PAYMENT_DEFAULT_ORDER_INFO,
                    amount,
                    redirectUrl,
                    ipnUrl,
                    user.email,
                    newPaymentInformation.paymentMethod,
                );
                const config = {
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(requestBody),
                    },
                };
                await momo_Request
                    .post('/create', requestBody, config)
                    .then((response) => {
                        newPaymentInformation.payUrl = response.data.payUrl;
                        newPaymentInformation.requestId = requestId;
                    })
                    .catch(async (error) => {
                        await session.abortTransaction();
                        throw new InvalidDataError(error.response?.message || error.message);
                    });
            } else if (newPaymentInformation.paymentMethod != PAYMENT_WITH_CASH) {
                await session.abortTransaction();
                throw new InvalidDataError('Phương thức thanh toán không hợp lệ');
            }
            newPaymentInformation.status = { state: 'initialized', description: 'Chưa thanh toán' };
            const createOrderPaymentInformation = await newPaymentInformation.save({ session });
            if (!createOrderPaymentInformation) {
                await session.abortTransaction();
                throw new InternalServerError('Gặp lỗi trong quá trình tạo thông tin thanh toán');
            }

            orderInfor.paymentInformation = createOrderPaymentInformation._id;

            //start cron-job
            // let scheduledJob = schedule.scheduleJob(
            //     // `*/${process.env.PAYMENT_EXPIRY_TIME_IN_MINUTE} * * * *`,
            //     async () => {
            //         const foundOrder = await Order.findOne({
            //             _id: orderInfor._id,
            //         }).populate('paymentInformation');
            //         if (!foundOrder.paymentInformation.paid) {
            //             if (
            //                 foundOrder.status != 'cancelled'
            //                 // &&
            //                 // foundOrder.status != 'delivered' &&
            //                 // foundOrder.status != 'completed'
            //             ) {
            //                 foundOrder.status = 'cancelled';
            //                 foundOrder.statusHistory.push({
            //                     status: 'cancelled',
            //                     description: 'Đơn hàng bị hủy do chưa được thanh toán',
            //                 });
            //                 await foundOrder.save();
            //                 console.log(`Đơn hàng "${orderInfor._id}" đã bị hủy `);
            //             }
            //         }
            //         scheduledJob.cancel();
            //     },
            // );

            await Cart.findOneAndUpdate(
                { user: req.user._id },
                { $pull: { cartItems: { variant: { $in: productCheckResult.orderItemIds } } } },
            )
                .session(session)
                .lean();

            //set order expiry time
            let now = new Date();
            if (isMomoPaymentMethods(newPaymentInformation.paymentMethod)) {
                now.setMinutes(now.getMinutes() + MAX_MINUTES_WAITING_TO_PAY);
            } else {
                now.setDate(now.getDate() + MAX_DAYS_WAITING_FOR_SHOP_CONFIRMATION);
            }
            orderInfor.expiredAt = now;

            const newOrder = await (await orderInfor.save({ session })).populate(['delivery', 'paymentInformation']);
            if (!newOrder) {
                await session.abortTransaction();
                throw new InternalServerError('Xảy ra lỗi trong quá trình tạo đơn hàng');
            }

            //schedule job
            if (isMomoPaymentMethods(newOrder.paymentInformation.paymentMethod)) {
                TaskService.scheduleCancelUnpaidOrder(newOrder);
            } else if (newOrder.paymentInformation.paymentMethod == PAYMENT_WITH_CASH) {
                TaskService.scheduleCancelUncofirmedOrder(newOrder);
            }

            await session.commitTransaction();
            res.json({ message: 'Đặt hàng thành công', data: { newOrder } });
        }, transactionOptions);
    } catch (error) {
        next(error);
    } finally {
        session.endSession();
    }
};

// Update: CONFIRM ORDER
const confirmOrder = async (req, res) => {
    // Validate the request data using express-validator
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const message = errors.array()[0].msg;
        throw new InvalidDataError(message);
    }
    const orderId = req.params.id || '';
    const description = String(req.body.description) || '';
    const order = await Order.findOne({ _id: orderId, disabled: false });
    if (!order) {
        throw new ItemNotFoundError('Đơn hàng không tồn tại!');
    }
    switch (order.status) {
        case 'confirm':
            throw new InvalidDataError('Đơn hàng đã được xác nhận');
        case 'delivering':
            throw new InvalidDataError('Đơn hàng đang ở trạng thái đang giao');
        case 'delivered':
            throw new InvalidDataError('Đơn hàng đã được giao thành công');
        case 'completed':
            throw new InvalidDataError('Đơn hàng đã được hoàn thành');
        case 'cancelled':
            throw new InvalidDataError('Đơn hàng đã bị hủy');
        default:
            break;
    }
    order.statusHistory.push({ status: 'confirm', description: description, updateBy: req.user._id });
    order.status = 'confirm';

    const updateOrder = await order.save();
    res.json({ message: 'Xác nhận đơn hàng thành công', data: { updateOrder } });
};

const confirmDelivery = async (req, res) => {
    // Validate the request data using express-validator
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const message = errors.array()[0].msg;
        throw new InvalidDataError(message);
    }
    const orderId = req.params.id;
    const description = req.body.description?.toString().trim() || '';
    const required_note = req.body.requiredNote || null;
    const order = await Order.findOne({ _id: orderId, disabled: false }).populate(['delivery', 'paymentInformation']);
    if (!order) {
        throw new ItemNotFoundError('Đơn hàng không tồn tại!');
    }
    switch (order.status) {
        case 'placed':
            throw new InvalidDataError('Đơn hàng chưa được xác nhận');
        case 'delivering':
            throw new InvalidDataError('Đơn hàng đã ở trạng thái đang giao');
        case 'delivered':
            throw new InvalidDataError('Đơn hàng đã được giao thành công');
        case 'completed':
            throw new InvalidDataError('Đơn hàng đã được hoàn thành');
        case 'cancelled':
            throw new InvalidDataError('Đơn hàng đã bị hủy');
        default:
            break;
    }
    let cod_amount = 0;
    if (!order.paymentInformation.paid) {
        if (isMomoPaymentMethods(order.paymentInformation.paymentMethod)) {
            throw new InvalidDataError('Đơn hàng chưa được thanh toán');
        }
        cod_amount = order.totalPayment;
    }

    const config = {
        data: JSON.stringify({
            shop_id: Number(process.env.GHN_SHOP_ID),
            payment_type_id: 1,
            note: order.delivery.note || '',
            required_note: required_note || order.delivery.required_note,
            client_order_code: Math.round(Math.random() * 1000000000).toString(),
            to_name: order.delivery.to_name,
            to_phone: order.delivery.to_phone,
            to_address: order.delivery.to_address,
            to_ward_name: order.delivery.to_ward_name,
            to_district_name: order.delivery.to_district_name,
            to_province_name: order.delivery.to_province_name,
            cod_amount: cod_amount,
            weight: order.delivery.weight,
            length: order.delivery.length,
            width: order.delivery.width,
            height: order.delivery.height,
            insurance_value: order.delivery.insurance_value,
            service_id: order.delivery.service_id,
            // pickup_time,
            items: order.delivery.items,
        }),
    };
    const deliveryInfo = await GHN_Request.get('v2/shipping-order/create', config)
        .then((response) => {
            return response.data.data;
        })
        .catch((error) => {
            res.status(error.response.data.code || 502);
            throw new InternalServerError(error.response.data.message || error.message || null);
        });
    order.delivery.start_date = new Date();
    order.delivery.leadTime = deliveryInfo.expected_delivery_time || order.delivery.leadTime;
    order.delivery.deliveryFee = deliveryInfo.total_fee || order.delivery.deliveryFee;
    order.delivery.deliveryCode = deliveryInfo.order_code || order.delivery.deliveryCode;
    // order.delivery.statusHistory = deliveryInfo.log || order.delivery.statusHistory;
    order.statusHistory.push({
        status: 'delivering',
        description: description,
        updateBy: req.user._id,
    });
    order.status = 'delivering';
    await order.delivery.save();
    const updateOrder = await (await order.save()).populate(['delivery', 'paymentInformation']);
    res.json({ message: 'Đơn giao hàng đã đặt thành công', data: { updateOrder } });
};

const confirmDelivered = async (req, res) => {
    // Validate the request data using express-validator
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const message = errors.array()[0].msg;
        throw new InvalidDataError(message);
    }
    const orderId = req.params.id || '';
    const description = req.body.description?.toString()?.trim() || '';
    const order = await Order.findOne({ _id: orderId, disabled: false }).populate(['delivery', 'paymentInformation']);
    if (!order) {
        throw new ItemNotFoundError('Đơn hàng không tồn tại!');
    }
    switch (order.status) {
        case 'placed':
            throw new InvalidDataError('Đơn hàng chưa được xác nhận');
        case 'confirm':
            throw new InvalidDataError('Đơn hàng đã ở trạng thái đang giao');
        case 'completed':
            throw new InvalidDataError('Đơn hàng đã được hoàn thành');
        case 'cancelled':
            throw new InvalidDataError('Đơn hàng đã bị hủy');
        default:
            break;
    }
    order.paymentInformation.paid = true;
    order.paymentInformation.paidAt = new Date();
    order.delivery.statusHistory.push({ status: 'delivered', updated_date: new Date() });
    order.delivery.status = 'delivered';
    order.delivery.finish_date = new Date();
    order.statusHistory.push({ status: 'delivered', description: description, updateBy: req.user._id });
    order.status = 'delivered';
    await order.delivery.save();
    const updateOrder = await order.save();
    res.json({ message: 'Xác nhận đã giao hàng thành công', data: { updateOrder } });
};

const confirmReceived = async (req, res) => {
    // Validate the request data using express-validator
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const message = errors.array()[0].msg;
        throw new InvalidDataError(message);
    }
    const orderId = req.params.id;
    const description = req.body.description?.toString()?.trim() || '';
    const order = await Order.findOne({ _id: orderId, disabled: false });
    if (!order) {
        throw new ItemNotFoundError('Đơn hàng không tồn tại!');
    }
    switch (order.status) {
        case 'placed':
            throw new InvalidDataError('Đơn hàng chưa được xác nhận');
        case 'confirm':
            throw new InvalidDataError('Đơn hàng  chỉ mới xác nhận chưa bắt đầu giao hàng');
        case 'completed':
            throw new InvalidDataError('Đơn hàng đã được hoàn thành');
        case 'cancelled':
            throw new InvalidDataError('Đơn hàng đã bị hủy');
        default:
            break;
    }
    order.statusHistory.push({ status: 'completed', description: description, updateBy: req.user._id });
    order.status = 'completed';
    order.orderItems = order.orderItems.map((orderItem) => {
        orderItem.isAbleToReview = true;
        return orderItem;
    });
    const updateOrder = await order.save();
    res.json({ message: 'Xác nhận đã nhận hàng thành công', data: { updateOrder } });
};

const validateIpnSignature = (order, req, res) => {
    const { resultCode, message, responseTime, extraData, signature, orderType, payType, transId } = req.query;
    const orderPayment = order.paymentInformation;
    const rawSignature =
        'accessKey=' +
        process.env.MOMO_ACCESS_KEY +
        '&amount=' +
        orderPayment.paymentAmount +
        '&extraData=' +
        extraData +
        '&message=' +
        message +
        '&orderId=' +
        order._id +
        '&orderInfo=' +
        PAYMENT_DEFAULT_ORDER_INFO +
        '&orderType=' +
        orderType +
        '&partnerCode=' +
        process.env.MOMO_PARTNER_CODE +
        '&payType=' +
        payType +
        '&requestId=' +
        orderPayment.requestId +
        '&responseTime=' +
        responseTime +
        '&resultCode=' +
        resultCode +
        '&transId=' +
        transId;
    const craftedSignature = crypto
        .createHmac('sha256', process.env.MOMO_SECRET_KEY)
        .update(rawSignature)
        .digest('hex');
    if (craftedSignature != signature) {
        throw new InvalidDataError('Chữ ký IPN không hợp lệ');
    }
};

const orderPaymentNotification = async (req, res, next) => {
    // Validate the request data using express-validator
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const message = errors.array()[0].msg;
        throw new InvalidDataError(message);
    }

    //validate
    const orderId = req.query.orderId;
    if (!orderId) {
        throw new InvalidDataError('Mã đơn hàng là giá trị bắt buộc');
    }
    const order = await Order.findOne({ _id: orderId, disabled: false }).populate('paymentInformation');
    if (!order) {
        throw new UnprocessableContentError('Đơn hàng không tồn tại!');
    }
    if (order.status == 'cancelled' || order.status == 'delivered' || order.status == 'completed') {
        throw new InvalidDataError('Đơn hàng đã hoàn thành hoặc bị hủy');
    }
    if (order.paymentInformation.paid) {
        throw new InvalidDataError('Đơn hàng đã được thanh toán');
    }
    if (
        order.paymentInformation?.requestId?.toString() != req.query.requestId?.toString() ||
        Number(order.paymentInformation.paymentAmount) != Number(req.query.amount)
    ) {
        throw new InvalidDataError('Thông tin xác nhận thanh toán không hợp lệ');
    }

    validateIpnSignature(order, req, res);

    if (req.query.resultCode != 0 && order.status == 'placed') {
        const message = statusResponseFalse[req.query.resultCode] || statusResponseFalse[99];

        //cancle order
        const session = await mongoose.startSession();
        const transactionOptions = {
            readPreference: 'primary',
            readConcern: { level: 'local' },
            writeConcern: { w: 'majority' },
        };
        try {
            await session.withTransaction(async () => {
                await rollbackProductQuantites(order, session);
                await cancelDelivery(order, session);
                //update order status
                order.status = 'cancelled';
                order.statusHistory.push({ status: 'cancelled', description: 'Từ chối thanh toán' });
                order.expiredAt = null;
                const cancelledOrder = await order.save();
                if (!cancelledOrder) {
                    await session.abortTransaction();
                    throw new InternalServerError('Gặp lỗi khi hủy đơn hàng');
                }
                console.error('Thanh toán thất bại, người dùng từ chối thanh toán');
            }, transactionOptions);
        } catch (error) {
            next(error);
        } finally {
            await session.endSession();
            return;
        }
    }
    if (order.status != 'cancelled') {
        order.statusHistory.push({ status: 'paid', updateBy: order.user });
    }
    order.paymentInformation.transId = req.query.transId;
    order.paymentInformation.paid = true;
    order.paymentInformation.paidAt = new Date();
    order.paymentInformation.status = { state: 'paid', description: 'Đã thanh toán' };
    await order.paymentInformation.save();
    order.expiredAt = null;
    await order.save();
};

const getOrderPaymentStatus = async (req, res) => {
    const orderId = req.params.id;
    const order = await Order.findOne({ _id: orderId, disabled: false }).populate('paymentInformation');
    if (!order) {
        throw new ItemNotFoundError('Đơn hàng không tồn tại!');
    }
    //Create payment information with momo
    const requestBody = createCheckStatusBody(order._id, order.paymentInformation.requestId);
    const config = {
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(requestBody),
        },
    };
    const result = await momo_Request
        .post('/query', requestBody, config)
        .then((response) => {
            if (response.data.resultCode == 0) {
                order.paymentInformation.refundTrans = response.data.refundTrans || [];
                order.paymentInformation.transId = response.data.transId || null;
                order.paymentInformation.save();
            }
            res.json(response.data);
        })
        .catch(async (error) => {
            throw new InternalServerError(error.response?.message || error.message);
        });
};

const refundOrderInCancel = async (paymentInformation) => {
    if (!isMomoPaymentMethods(paymentInformation.paymentMethod)) {
        return;
    }
    //Create payment information with momo
    // const requestBody = createRefundTransBody(orderId, order.paymentInformation.requestId);
    const requestBody = createRefundTransBody(
        uuidv4(),
        paymentInformation.paymentAmount,
        'Hoàn tiền qua ví Momo',
        paymentInformation.requestId,
        paymentInformation.transId,
    );
    const config = {
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(requestBody),
        },
    };
    const result = await momo_Request
        .post('/refund', requestBody, config)
        .then(async (response) => {
            paymentInformation.status = { state: 'refunded', description: 'Hoàn tiền thành công' };
            await paymentInformation.save();
            return;
        })
        .catch(async (error) => {
            console.log(error);
            throw new InternalServerError(error.response?.message || error.message);
        });
};

const refundTrans = async (req, res) => {
    const orderId = req.params.id;
    const order = await Order.findOne({ _id: orderId, disabled: false }).populate('paymentInformation');
    if (!order) {
        throw new ItemNotFoundError('Đơn hàng không tồn tại!');
    }
    //Create payment information with momo
    // const requestBody = createRefundTransBody(orderId, order.paymentInformation.requestId);
    const requestBody = createRefundTransBody(
        uuidv4(),
        order.paymentInformation.paymentAmount,
        'Hoàn tiền qua ví Momo',
        order.paymentInformation.requestId,
        order.paymentInformation.transId,
    );
    const config = {
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(requestBody),
        },
    };
    const result = await momo_Request
        .post('/refund', requestBody, config)
        .then((response) => {
            res.json(response.data);
        })
        .catch(async (error) => {
            console.log(error);
            throw new InternalServerError(error.response?.message || error.message);
        });
};

const adminPaymentOrder = async (req, res) => {
    // Validate the request data using express-validator
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const message = errors.array()[0].msg;
        throw new InvalidDataError(message);
    }
    const orderId = req.params.id;
    const order = await Order.findOne({ _id: orderId, disabled: false }).populate('paymentInformation');
    if (!order) {
        throw new ItemNotFoundError('Đơn hàng không tồn tại!');
    }
    if (order.paymentInformation.paid == true) {
        throw new InvalidDataError('Đơn hàng đã hoàn thành việc thanh toán');
    }
    const session = await mongoose.startSession();
    const transactionOptions = {
        readPreference: 'primary',
        readConcern: { level: 'local' },
        writeConcern: { w: 'majority' },
    };

    try {
        await session.withTransaction(async () => {
            order.paymentInformation.paid = true;
            order.paymentInformation.paidAt = new Date();
            order.statusHistory.push({
                status: 'paid',
                updateBy: req.user._id,
            });
            if (order.delivery.deliveryCode && order.delivery?.deliveryCode.trim() != '') {
                {
                    const config = {
                        data: JSON.stringify({
                            order_code: order.delivery.deliveryCode,
                            cod_amount: 0,
                        }),
                    };
                    await GHN_Request.get('/v2/shipping-order/updateCOD', config)
                        .then(async (response) => {
                            order.delivery.cod_amount = cod_amount;
                            await order.delivery.save({ session });
                        })
                        .catch((error) => {
                            res.status(error.response.data.code || 500);
                            throw new InternalServerError(
                                error.response.data.message.code_message_value ||
                                    error.response.data.message ||
                                    error.message ||
                                    '',
                            );
                        });
                }
            }
            await order.paymentInformation.save({ session });
            const updateOrder = await (await order.save({ session })).populate(['delivery', 'paymentInformation']);
            res.json({ message: 'Xác nhận thanh toán đơn hàng thành công', data: { updateOrder } });
        }, transactionOptions);
    } catch (error) {
        next(error);
    } finally {
        session.endSession();
    }
};

const cancelOrder = async (req, res, next) => {
    // Validate the request data using express-validator
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const message = errors.array()[0].msg;
        throw new InvalidDataError(message);
    }
    const orderId = req.params.id || '';
    const description = req.body.description?.toString()?.trim() || '';
    const order = await Order.findOne({ _id: orderId }).populate('delivery').populate('paymentInformation');

    if (!order) {
        throw new ItemNotFoundError('Đơn hàng không tồn tại');
    }
    if (req.user.role == 'admin' || req.user.role == 'staff') {
        switch (order.status) {
            case 'delivered':
                throw new InvalidDataError('Đơn hàng đã được giao thành công. Không thể hủy đơn hàng');
            case 'completed':
                throw new InvalidDataError('Đơn hàng đã được hoàn thành. Không thể hủy đơn hàng');
            case 'cancelled':
                throw new InvalidDataError('Đơn hàng đã bị hủy');
            default:
                break;
        }
    } else if (req.user._id.toString() == order.user.toString()) {
        switch (order.status) {
            // case 'confirm':
            //     res.status(400);
            //     throw new Error('Đơn hàng đã được xác nhận. Không thể hủy đơn hàng');
            case 'delivering':
                throw new InvalidDataError('Đơn hàng đang được giao đến bạn. Không thể hủy đơn hàng');
            case 'delivered':
                throw new InvalidDataError('Đơn hàng đã được giao thành công. Không thể hủy đơn hàng');
            case 'completed':
                throw new InvalidDataError('Đơn hàng đã được hoàn thành. Không thể hủy đơn hàng');
            case 'cancelled':
                throw new InvalidDataError('Đơn hàng đã bị hủy');
            default:
                break;
        }
    } else {
        throw new ItemNotFoundError('Đơn hàng không tồn tại');
    }
    const session = await mongoose.startSession();
    const transactionOptions = {
        readPreference: 'primary',
        readConcern: { level: 'local' },
        writeConcern: { w: 'majority' },
    };
    try {
        await session.withTransaction(async () => {
            await rollbackProductQuantites(order, session);
            await cancelDelivery(order, session);
            await refundOrderInCancel(order.paymentInformation);
            //update order status
            order.status = 'cancelled';
            order.statusHistory.push({ status: 'cancelled', description: description });
            const cancelledOrder = await order.save();
            if (!cancelledOrder) {
                await session.abortTransaction();
                throw new InternalServerError('Gặp lỗi khi hủy đơn hàng');
            }
            res.json({ message: 'Hủy đơn hàng thành công' });
        }, transactionOptions);
    } catch (error) {
        next(error);
    } finally {
        await session.endSession();
    }
};

const rollbackProductQuantites = async (order, session) => {
    const updateOrderItems = order.orderItems.map(async (orderItem) => {
        const updateProduct = await Product.findOneAndUpdate(
            { _id: orderItem.product },
            { $inc: { totalSales: -orderItem.quantity, quantity: +orderItem.quantity } },
        )
            .session(session)
            .lean();
        const updateVariant = await Variant.findOneAndUpdate(
            { product: orderItem.product._id, attributes: orderItem.attributes },
            { $inc: { quantity: +orderItem.quantity } },
            { new: true },
        )
            .session(session)
            .lean();
    });
    await Promise.all(updateOrderItems);
};

const cancelDelivery = async (order, session) => {
    if (order.status == 'delivering' && order.delivery.deliveryCode) {
        const config = {
            data: JSON.stringify({
                shop_id: Number(process.env.GHN_SHOP_ID),
                order_codes: [new String(order.delivery.deliveryCode)],
            }),
        };
        const deliveryInfo = await GHN_Request.get('v2/switch-status/cancel', config)
            .then((response) => {
                return response.data.data;
            })
            .catch((error) => {
                res.status(error.response.data.code || 502);
                throw new InternalServerError(error.response.data.message || error.message || null);
            });

        if (!deliveryInfo) {
            await session.abortTransaction();
            res.status(502);
            throw new InternalServerError('Gặp lỗi khi hủy đơn giao hàng của đơn vị Giao Hàng Nhanh');
        }
    }
};

const isMomoPaymentMethods = (paymentMethod) => {
    return (
        paymentMethod == PAYMENT_WITH_MOMO ||
        paymentMethod == PAYMENT_WITH_ATM ||
        paymentMethod == PAYMENT_WITH_CREDIT_CARD
    );
};

const OrderService = {
    getOrdersByUserId,
    getOrderById,
    getOrders,
    createOrder,
    confirmOrder,
    confirmDelivery,
    confirmDelivered,
    confirmReceived,
    orderPaymentNotification,
    adminPaymentOrder,
    cancelOrder,
    getOrderPaymentStatus,
    refundTrans,
    refundOrderInCancel,
    rollbackProductQuantites,
    cancelDelivery,
};

export default OrderService;