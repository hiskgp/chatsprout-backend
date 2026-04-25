import { Router } from 'express';
const router = Router();
router.get('/', (req, res) => {
  res.json([
    { id: 101, customer: 'Srikeerthi', amount: 1250, status: 'pending' },
    { id: 102, customer: 'Customer A', amount: 890, status: 'completed' }
  ]);
});
export default router;

// // import { Router } from 'express';
// // import { z } from 'zod';
// // import { authMiddleware } from '../../middleware/auth';
// // import { hasPermission } from '../../middleware/rbac';
// // import { asyncHandler } from '../../middleware/error';
// // import { prisma } from '../../utils/prisma';
// // import { getQueue, QUEUE_NAMES } from '../../services/redis.service';
// // import { BadRequestError, NotFoundError } from '../../utils/errors';
// // import { logger } from '../../utils/logger';

// // const router = Router();

// // // All order routes require authentication
// // router.use(authMiddleware);

// import { Router } from 'express';
// import { z } from 'zod';
// // import { authenticate } from '../../middleware/auth';
// import { authMiddleware } from '../../middleware/auth';

// import { hasPermission } from '../../middleware/rbac';
// import { asyncHandler } from '../../middleware/error';
// import { prisma } from '../../utils/prisma';
// import { getQueue, QUEUE_NAMES } from '../../services/redis.service';
// import { BadRequestError, NotFoundError } from '../../utils/errors';
// import { logger } from '../../utils/logger';

// const router = Router();

// // All order routes require authentication
// // router.use(authenticate);
// router.use(authMiddleware);


// // Validation schemas
// const updateOrderSchema = z.object({
//   status: z.enum(['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED']).optional(),
//   notes: z.string().optional(),
//   trackingNumber: z.string().optional(),
// });

// const listOrdersSchema = z.object({
//   status: z.enum(['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED']).optional(),
//   contactId: z.string().optional(),
//   startDate: z.string().datetime().optional(),
//   endDate: z.string().datetime().optional(),
//   page: z.coerce.number().min(1).default(1),
//   limit: z.coerce.number().min(1).max(100).default(20),
//   search: z.string().optional(),
// });

// /**
//  * GET /api/orders
//  * List orders with filters and pagination
//  */
// router.get(
//   '/',
//   hasPermission('orders.view'),
//   asyncHandler(async (req, res) => {
//     const params = listOrdersSchema.parse(req.query);
//     const { status, contactId, startDate, endDate, page, limit, search } = params;

//     const where: any = { orgId: req.orgId };

//     if (status) where.status = status;
//     if (contactId) where.contactId = contactId;
//     if (startDate || endDate) {
//       where.createdAt = {};
//       if (startDate) where.createdAt.gte = new Date(startDate);
//       if (endDate) where.createdAt.lte = new Date(endDate);
//     }
//     if (search) {
//       where.OR = [
//         { orderNumber: { contains: search, mode: 'insensitive' } },
//         { contact: { name: { contains: search, mode: 'insensitive' } } },
//         { contact: { phone: { contains: search } } },
//       ];
//     }

//     const [orders, total] = await Promise.all([
//       prisma.order.findMany({
//         where,
//         include: {
//           contact: {
//             select: {
//               id: true,
//               name: true,
//               phone: true,
//               email: true,
//             },
//           },
//           items: {
//             include: {
//               product: {
//                 select: {
//                   id: true,
//                   name: true,
//                   sku: true,
//                   imageUrl: true,
//                 },
//               },
//             },
//           },
//           conversation: {
//             select: {
//               id: true,
//             },
//           },
//         },
//         orderBy: { createdAt: 'desc' },
//         skip: (page - 1) * limit,
//         take: limit,
//       }),
//       prisma.order.count({ where }),
//     ]);

//     res.json({
//       success: true,
//       data: orders,
//       meta: {
//         total,
//         page,
//         limit,
//         totalPages: Math.ceil(total / limit),
//       },
//     });
//   })
// );

// /**
//  * GET /api/orders/:id
//  * Get single order with full details
//  */
// router.get(
//   '/:id',
//   hasPermission('orders.view'),
//   asyncHandler(async (req, res) => {
//     const { id } = req.params;

//     const order = await prisma.order.findFirst({
//       where: {
//         id,
//         orgId: req.orgId,
//       },
//       include: {
//         contact: {
//           select: {
//             id: true,
//             name: true,
//             phone: true,
//             email: true,
//             tags: true,
//           },
//         },
//         items: {
//           include: {
//             product: {
//               select: {
//                 id: true,
//                 name: true,
//                 sku: true,
//                 description: true,
//                 imageUrl: true,
//                 price: true,
//               },
//             },
//           },
//         },
//         conversation: {
//           select: {
//             id: true,
//             status: true,
//           },
//         },
//       },
//     });

//     if (!order) {
//       throw new NotFoundError('Order not found');
//     }

//     res.json({
//       success: true,
//       data: order,
//     });
//   })
// );

// /**
//  * PATCH /api/orders/:id
//  * Update order status, notes, tracking
//  */
// router.patch(
//   '/:id',
//   hasPermission('orders.update'),
//   asyncHandler(async (req, res) => {
//     const { id } = req.params;
//     const updates = updateOrderSchema.parse(req.body);

//     // Check order exists
//     const order = await prisma.order.findFirst({
//       where: {
//         id,
//         orgId: req.orgId,
//       },
//     });

//     if (!order) {
//       throw new NotFoundError('Order not found');
//     }

//     // Update order
//     const updatedOrder = await prisma.order.update({
//       where: { id },
//       data: {
//         ...updates,
//         updatedAt: new Date(),
//       },
//       include: {
//         contact: {
//           select: {
//             id: true,
//             name: true,
//             phone: true,
//           },
//         },
//       },
//     });

//     // If status changed, send WhatsApp notification
//     if (updates.status && updates.status !== order.status) {
//       const queue = getQueue(QUEUE_NAMES.WHATSAPP_SEND);
//       await queue.add('send-order-update', {
//         orgId: req.orgId,
//         contactId: order.contactId,
//         orderNumber: order.orderNumber,
//         oldStatus: order.status,
//         newStatus: updates.status,
//         trackingNumber: updates.trackingNumber,
//       });

//       logger.info(`Order status updated: ${order.orderNumber}`, {
//         orderId: id,
//         oldStatus: order.status,
//         newStatus: updates.status,
//         userId: req.userId,
//       });
//     }

//     res.json({
//       success: true,
//       data: updatedOrder,
//       message: 'Order updated successfully',
//     });
//   })
// );

// /**
//  * POST /api/orders/:id/confirm
//  * Confirm pending order
//  */
// router.post(
//   '/:id/confirm',
//   hasPermission('orders.update'),
//   asyncHandler(async (req, res) => {
//     const { id } = req.params;

//     const order = await prisma.order.findFirst({
//       where: {
//         id,
//         orgId: req.orgId,
//         status: 'PENDING',
//       },
//     });

//     if (!order) {
//       throw new NotFoundError('Pending order not found');
//     }

//     const updatedOrder = await prisma.order.update({
//       where: { id },
//       data: {
//         status: 'CONFIRMED',
//         confirmedAt: new Date(),
//       },
//       include: {
//         contact: {
//           select: {
//             id: true,
//             name: true,
//             phone: true,
//           },
//         },
//         items: true,
//       },
//     });

//     // Send confirmation to customer
//     const queue = getQueue(QUEUE_NAMES.WHATSAPP_SEND);
//     await queue.add('send-order-confirmation', {
//       orgId: req.orgId,
//       contactId: order.contactId,
//       orderNumber: order.orderNumber,
//       items: updatedOrder.items,
//       total: order.total,
//     });

//     logger.info(`Order confirmed: ${order.orderNumber}`, {
//       orderId: id,
//       userId: req.userId,
//     });

//     res.json({
//       success: true,
//       data: updatedOrder,
//       message: 'Order confirmed and customer notified',
//     });
//   })
// );

// /**
//  * POST /api/orders/:id/cancel
//  * Cancel order
//  */
// router.post(
//   '/:id/cancel',
//   hasPermission('orders.update'),
//   asyncHandler(async (req, res) => {
//     const { id } = req.params;
//     const { reason } = req.body;

//     const order = await prisma.order.findFirst({
//       where: {
//         id,
//         orgId: req.orgId,
//         status: { in: ['PENDING', 'CONFIRMED', 'PROCESSING'] },
//       },
//     });

//     if (!order) {
//       throw new NotFoundError('Cancellable order not found');
//     }

//     const updatedOrder = await prisma.order.update({
//       where: { id },
//       data: {
//         status: 'CANCELLED',
//         cancelledAt: new Date(),
//         cancellationReason: reason || 'Cancelled by admin',
//       },
//     });

//     // Notify customer
//     const queue = getQueue(QUEUE_NAMES.WHATSAPP_SEND);
//     await queue.add('send-order-cancellation', {
//       orgId: req.orgId,
//       contactId: order.contactId,
//       orderNumber: order.orderNumber,
//       reason: reason || 'Order cancelled',
//     });

//     logger.info(`Order cancelled: ${order.orderNumber}`, {
//       orderId: id,
//       reason,
//       userId: req.userId,
//     });

//     res.json({
//       success: true,
//       data: updatedOrder,
//       message: 'Order cancelled',
//     });
//   })
// );

// /**
//  * GET /api/orders/stats/summary
//  * Order statistics summary
//  */
// router.get(
//   '/stats/summary',
//   hasPermission('orders.view'),
//   asyncHandler(async (req, res) => {
//     const { period = '30d' } = req.query;

//     const dateRange = (() => {
//       const now = new Date();
//       const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
//       return {
//         gte: new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
//         lte: now,
//       };
//     })();

//     const [totalOrders, totalRevenue, byStatus, avgOrderValue, topProducts] = await Promise.all([
//       // Total orders
//       prisma.order.count({
//         where: {
//           orgId: req.orgId,
//           createdAt: dateRange,
//         },
//       }),

//       // Total revenue
//       prisma.order.aggregate({
//         where: {
//           orgId: req.orgId,
//           status: { in: ['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED'] },
//           createdAt: dateRange,
//         },
//         _sum: { total: true },
//       }),

//       // Orders by status
//       prisma.order.groupBy({
//         by: ['status'],
//         where: {
//           orgId: req.orgId,
//           createdAt: dateRange,
//         },
//         _count: true,
//       }),

//       // Average order value
//       prisma.order.aggregate({
//         where: {
//           orgId: req.orgId,
//           status: { in: ['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED'] },
//           createdAt: dateRange,
//         },
//         _avg: { total: true },
//       }),

//       // Top products
//       prisma.$queryRawUnsafe<any[]>(
//         `
//         SELECT
//           p.name,
//           p.sku,
//           COUNT(oi.id) as order_count,
//           SUM(oi.quantity) as total_quantity,
//           SUM(oi.price * oi.quantity) as total_revenue
//         FROM "OrderItem" oi
//         JOIN "Product" p ON p.id = oi.product_id
//         JOIN "Order" o ON o.id = oi.order_id
//         WHERE o.org_id = $1
//           AND o.created_at >= $2
//           AND o.created_at <= $3
//           AND o.status IN ('CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED')
//         GROUP BY p.id, p.name, p.sku
//         ORDER BY total_revenue DESC
//         LIMIT 5
//       `,
//         req.orgId,
//         dateRange.gte,
//         dateRange.lte
//       ),
//     ]);

//     res.json({
//       success: true,
//       data: {
//         totalOrders,
//         totalRevenue: totalRevenue._sum.total || 0,
//         avgOrderValue: avgOrderValue._avg.total || 0,
//         byStatus: byStatus.map((s) => ({
//           status: s.status,
//           count: s._count,
//         })),
//         topProducts: topProducts.map((p) => ({
//           name: p.name,
//           sku: p.sku,
//           orderCount: Number(p.order_count),
//           totalQuantity: Number(p.total_quantity),
//           totalRevenue: Number(p.total_revenue),
//         })),
//         period,
//       },
//     });
//   })
// );

// /**
//  * POST /api/orders/webhook
//  * Receive orders from WhatsApp Catalog
//  * NOTE: Called by webhooks.routes.ts after verification
//  */
// router.post(
//   '/webhook',
//   asyncHandler(async (req, res) => {
//     // This endpoint is called internally by webhooks.routes.ts
//     // after verifying WhatsApp signature
//     const { orgId, contactId, orderData } = req.body;

//     if (!orgId || !contactId || !orderData) {
//       throw new BadRequestError('Missing required fields');
//     }

//     // Generate order number
//     const orderCount = await prisma.order.count({
//       where: { orgId },
//     });
//     const orderNumber = `ORD-${String(orderCount + 1).padStart(6, '0')}`;

//     // Create order
//     const order = await prisma.order.create({
//       data: {
//         orgId,
//         contactId,
//         orderNumber,
//         status: 'PENDING',
//         subtotal: orderData.subtotal,
//         tax: orderData.tax || 0,
//         shipping: orderData.shipping || 0,
//         total: orderData.total,
//         currency: orderData.currency || 'INR',
//         items: {
//           create: orderData.items.map((item: any) => ({
//             productId: item.productId,
//             quantity: item.quantity,
//             price: item.price,
//             name: item.name,
//             sku: item.sku,
//           })),
//         },
//         whatsappOrderId: orderData.whatsappOrderId,
//         conversationId: orderData.conversationId,
//       },
//       include: {
//         contact: {
//           select: {
//             id: true,
//             name: true,
//             phone: true,
//           },
//         },
//         items: true,
//       },
//     });

//     logger.info(`Order created from WhatsApp: ${orderNumber}`, {
//       orderId: order.id,
//       orgId,
//       contactId,
//       total: order.total,
//     });

//     // Send order received notification
//     const queue = getQueue(QUEUE_NAMES.WHATSAPP_SEND);
//     await queue.add('send-order-received', {
//       orgId,
//       contactId,
//       orderNumber,
//       total: order.total,
//     });

//     res.json({
//       success: true,
//       data: order,
//     });
//   })
// );

// export default router;