import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import { hasPermission, requireResourceOwnership } from '../../middleware/rbac';
import { asyncHandler } from '../../middleware/error';
import { prisma } from '../../utils/prisma';
import { getQueue, QUEUE_NAMES } from '../../services/redis.service';
import { BadRequestError, NotFoundError, ForbiddenError } from '../../utils/errors';
import { logger } from '../../utils/logger';

const router = Router();

// All inbox routes require authentication
router.use(authMiddleware);

// Validation schemas
const sendMessageSchema = z.object({
  to: z.string().regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone number'),
  type: z.enum(['text', 'image', 'document', 'template']),
  text: z.object({ body: z.string().min(1).max(4096) }).optional(),
  image: z.object({ link: z.string().url(), caption: z.string().optional() }).optional(),
  document: z.object({ 
    link: z.string().url(), 
    filename: z.string().optional(),
    caption: z.string().optional() 
  }).optional(),
  template: z.object({
    name: z.string(),
    language: z.string().default('en'),
    components: z.array(z.any()).optional(),
  }).optional(),
});

const assignConversationSchema = z.object({
  assignedToId: z.string().uuid().nullable(),
});

const updateConversationStatusSchema = z.object({
  status: z.enum(['OPEN', 'PENDING', 'CLOSED', 'ARCHIVED']),
});

/**
 * GET /api/inbox/conversations
 * Get all conversations for org with filters
 */
router.get(
  '/conversations',
  hasPermission('inbox.view_all'),
  asyncHandler(async (req, res) => {
    const { status, assignedToId, search, page = '1', limit = '20' } = req.query;

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    // Build where clause
    const where: any = { orgId: req.orgId };

    if (status) {
      where.status = status;
    }

    if (assignedToId) {
      where.assignedToId = assignedToId;
    } else if (req.user!.role === 'AGENT') {
      // Agents can only see assigned conversations
      where.assignedToId = req.user!.id;
    }

    if (search) {
      where.OR = [
        { contact: { name: { contains: search as string, mode: 'insensitive' } } },
        { contact: { phoneNumber: { contains: search as string } } },
      ];
    }

    // Get conversations with last message
    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: {
          contact: {
            select: {
              id: true,
              name: true,
              phoneNumber: true,
              avatar: true,
              tags: true,
            },
          },
          assignedTo: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          messages: {
            take: 1,
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              content: true,
              type: true,
              direction: true,
              createdAt: true,
              status: true,
            },
          },
        },
        orderBy: { lastMessageAt: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.conversation.count({ where }),
    ]);

    res.json({
      success: true,
      data: conversations,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  })
);

/**
 * GET /api/inbox/conversations/:id
 * Get single conversation with messages
 */
router.get(
  '/conversations/:id',
  requireResourceOwnership('conversation'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { page = '1', limit = '50' } = req.query;

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: {
        contact: true,
        assignedTo: {
          select: { id: true, name: true, email: true },
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          skip,
          take: limitNum,
        },
      },
    });

    if (!conversation) {
      throw new NotFoundError('Conversation not found');
    }

    // Mark messages as read
    await prisma.message.updateMany({
      where: {
        conversationId: id,
        direction: 'INBOUND',
        status: { not: 'READ' },
      },
      data: { status: 'READ' },
    });

    // Reset unread count
    await prisma.conversation.update({
      where: { id },
      data: { unreadCount: 0 },
    });

    res.json({
      success: true,
      data: conversation,
    });
  })
);

/**
 * POST /api/inbox/conversations/:id/messages
 * Send message in conversation
 */
router.post(
  '/conversations/:id/messages',
  requireResourceOwnership('conversation'),
  hasPermission('inbox.send_message'),
  asyncHandler(async (req, res) => {
    const { id: conversationId } = req.params;
    const validated = sendMessageSchema.parse(req.body);

    // Get conversation
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: true },
    });

    if (!conversation) {
      throw new NotFoundError('Conversation not found');
    }

    if (conversation.status === 'CLOSED') {
      throw new BadRequestError('Cannot send message to closed conversation');
    }

    // Queue message for sending
    const queue = getQueue(QUEUE_NAMES.WHATSAPP_SEND);
    const job = await queue.add('send-message', {
      orgId: req.orgId,
      payload: {
        to: validated.to || conversation.contact.phoneNumber,
        ...validated,
      },
    });

    // Create pending message in DB
    const message = await prisma.message.create({
      data: {
        whatsappId: job.id!, // Temporary ID
        orgId: req.orgId!,
        conversationId,
        contactId: conversation.contactId,
        direction: 'OUTBOUND',
        type: validated.type.toUpperCase(),
        content: JSON.stringify(validated),
        status: 'PENDING',
        sentById: req.user!.id,
      },
    });

    logger.info(`Message queued: ${message.id}`, { conversationId, type: validated.type });

    res.status(201).json({
      success: true,
      data: message,
    });
  })
);

/**
 * PATCH /api/inbox/conversations/:id/assign
 * Assign conversation to agent
 */
router.patch(
  '/conversations/:id/assign',
  requireResourceOwnership('conversation'),
  hasPermission('inbox.assign_conversation'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { assignedToId } = assignConversationSchema.parse(req.body);

    // Verify agent exists and belongs to org
    if (assignedToId) {
      const agent = await prisma.user.findFirst({
        where: {
          id: assignedToId,
          orgId: req.orgId,
          role: { in: ['AGENT', 'ADMIN', 'OWNER'] },
        },
      });

      if (!agent) {
        throw new BadRequestError('Invalid agent ID');
      }
    }

    const conversation = await prisma.conversation.update({
      where: { id },
      data: { assignedToId },
      include: {
        assignedTo: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    logger.info(`Conversation assigned: ${id}`, { assignedTo: assignedToId });

    res.json({
      success: true,
      data: conversation,
    });
  })
);

/**
 * PATCH /api/inbox/conversations/:id/status
 * Update conversation status (close, archive, etc)
 */
router.patch(
  '/conversations/:id/status',
  requireResourceOwnership('conversation'),
  hasPermission('inbox.close_conversation'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status } = updateConversationStatusSchema.parse(req.body);

    const conversation = await prisma.conversation.update({
      where: { id },
      data: { status },
    });

    logger.info(`Conversation status updated: ${id}`, { status });

    res.json({
      success: true,
      data: conversation,
    });
  })
);

/**
 * DELETE /api/inbox/conversations/:id
 * Delete conversation (soft delete)
 */
router.delete(
  '/conversations/:id',
  requireResourceOwnership('conversation'),
  hasPermission('inbox.view_all'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Only OWNER and ADMIN can delete
    if (req.user!.role!== 'OWNER' && req.user!.role!== 'ADMIN') {
      throw new ForbiddenError('Only owners and admins can delete conversations');
    }

    await prisma.conversation.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    });

    logger.info(`Conversation archived: ${id}`);

    res.json({
      success: true,
      message: 'Conversation archived successfully',
    });
  })
);

/**
 * GET /api/inbox/stats
 * Get inbox statistics
 */
router.get(
  '/stats',
  hasPermission('inbox.view_all'),
  asyncHandler(async (req, res) => {
    const where = { orgId: req.orgId };

    const [total, open, pending, closed, unread] = await Promise.all([
      prisma.conversation.count({ where }),
      prisma.conversation.count({ where: { ...where, status: 'OPEN' } }),
      prisma.conversation.count({ where: { ...where, status: 'PENDING' } }),
      prisma.conversation.count({ where: { ...where, status: 'CLOSED' } }),
      prisma.conversation.aggregate({
        where,
        _sum: { unreadCount: true },
      }),
    ]);

    res.json({
      success: true,
      data: {
        total,
        open,
        pending,
        closed,
        unreadMessages: unread._sum.unreadCount || 0,
      },
    });
  })
);

export default router;