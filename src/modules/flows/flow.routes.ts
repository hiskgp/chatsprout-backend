import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import { hasPermission } from '../../middleware/rbac';
import { asyncHandler } from '../../middleware/error';
import { prisma } from '../../utils/prisma';
import { cache } from '../../services/redis.service';
import { BadRequestError, NotFoundError, ForbiddenError } from '../../utils/errors';
import { logger } from '../../utils/logger';

const router = Router();

// All flow routes require authentication
router.use(authMiddleware);

// Validation schemas
const flowNodeSchema = z.object({
  id: z.string(),
  type: z.enum(['trigger', 'message', 'condition', 'action', 'delay', 'webhook', 'ai']),
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.record(z.any()),
});

const flowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().optional(),
  label: z.string().optional(),
});

const createFlowSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  nodes: z.array(flowNodeSchema).min(1),
  edges: z.array(flowEdgeSchema),
  trigger: z.enum(['keyword', 'welcome', 'api', 'schedule']),
  triggerValue: z.string().optional(),
  isActive: z.boolean().default(false),
});

const updateFlowSchema = createFlowSchema.partial();

const testFlowSchema = z.object({
  phoneNumber: z.string().regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone number'),
  variables: z.record(z.string()).optional(),
});

/**
 * GET /api/flows
 * Get all flows for org
 */
router.get(
  '/',
  hasPermission('flows.view'),
  asyncHandler(async (req, res) => {
    const { status, trigger, page = '1', limit = '20' } = req.query;

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    const where: any = { orgId: req.orgId };

    if (status === 'active') {
      where.isActive = true;
    } else if (status === 'draft') {
      where.isActive = false;
    }

    if (trigger) {
      where.trigger = trigger;
    }

    const [flows, total] = await Promise.all([
      prisma.flow.findMany({
        where,
        include: {
          createdBy: {
            select: { id: true, name: true, email: true },
          },
          _count: {
            select: { executions: true },
          },
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.flow.count({ where }),
    ]);

    res.json({
      success: true,
      data: flows,
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
 * GET /api/flows/:id
 * Get single flow with full node data
 */
router.get(
  '/:id',
  hasPermission('flows.view'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const flow = await prisma.flow.findFirst({
      where: { id, orgId: req.orgId },
      include: {
        createdBy: {
          select: { id: true, name: true, email: true },
        },
        executions: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            status: true,
            contactId: true,
            currentNodeId: true,
            createdAt: true,
          },
        },
      },
    });

    if (!flow) {
      throw new NotFoundError('Flow not found');
    }

    res.json({
      success: true,
      data: flow,
    });
  })
);

/**
 * POST /api/flows
 * Create new flow
 */
router.post(
  '/',
  hasPermission('flows.create'),
  asyncHandler(async (req, res) => {
    const validated = createFlowSchema.parse(req.body);

    // Validate flow structure
    const triggerNodes = validated.nodes.filter((n) => n.type === 'trigger');
    if (triggerNodes.length === 0) {
      throw new BadRequestError('Flow must have at least one trigger node');
    }

    if (triggerNodes.length > 1) {
      throw new BadRequestError('Flow can only have one trigger node');
    }

    // Check for duplicate name
    const existing = await prisma.flow.findFirst({
      where: {
        orgId: req.orgId,
        name: validated.name,
      },
    });

    if (existing) {
      throw new BadRequestError('Flow with this name already exists');
    }

    const flow = await prisma.flow.create({
      data: {
        ...validated,
        orgId: req.orgId!,
        createdById: req.user!.id,
        nodes: validated.nodes,
        edges: validated.edges,
      },
      include: {
        createdBy: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    // Clear cache
    await cache.delPattern(`flows:${req.orgId}:*`);

    logger.info(`Flow created: ${flow.id}`, { orgId: req.orgId, name: flow.name });

    res.status(201).json({
      success: true,
      data: flow,
    });
  })
);

/**
 * PATCH /api/flows/:id
 * Update flow
 */
router.patch(
  '/:id',
  hasPermission('flows.edit'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const validated = updateFlowSchema.parse(req.body);

    // Check if flow exists and belongs to org
    const existing = await prisma.flow.findFirst({
      where: { id, orgId: req.orgId },
    });

    if (!existing) {
      throw new NotFoundError('Flow not found');
    }

    // Cannot edit published flow without creating new version
    if (existing.isActive && validated.nodes) {
      throw new BadRequestError('Cannot edit active flow. Duplicate it or deactivate first');
    }

    // Check for name conflict
    if (validated.name && validated.name !== existing.name) {
      const duplicate = await prisma.flow.findFirst({
        where: {
          orgId: req.orgId,
          name: validated.name,
          id: { not: id },
        },
      });

      if (duplicate) {
        throw new BadRequestError('Flow with this name already exists');
      }
    }

    const flow = await prisma.flow.update({
      where: { id },
      data: {
        ...validated,
        version: existing.version + 1,
      },
    });

    // Clear cache
    await cache.delPattern(`flows:${req.orgId}:*`);

    logger.info(`Flow updated: ${id}`, { version: flow.version });

    res.json({
      success: true,
      data: flow,
    });
  })
);

/**
 * DELETE /api/flows/:id
 * Delete flow (soft delete if has executions)
 */
router.delete(
  '/:id',
  hasPermission('flows.delete'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const flow = await prisma.flow.findFirst({
      where: { id, orgId: req.orgId },
      include: { _count: { select: { executions: true } } },
    });

    if (!flow) {
      throw new NotFoundError('Flow not found');
    }

    // Soft delete if has executions
    if (flow._count.executions > 0) {
      await prisma.flow.update({
        where: { id },
        data: { isActive: false, status: 'ARCHIVED' },
      });

      logger.info(`Flow archived (has executions): ${id}`);
      res.json({
        success: true,
        message: 'Flow archived successfully',
      });
    } else {
      // Hard delete if no executions
      await prisma.flow.delete({
        where: { id },
      });

      logger.info(`Flow deleted: ${id}`);
      res.json({
        success: true,
        message: 'Flow deleted successfully',
      });
    }

    // Clear cache
    await cache.delPattern(`flows:${req.orgId}:*`);
  })
);

/**
 * POST /api/flows/:id/publish
 * Publish/activate flow
 */
router.post(
  '/:id/publish',
  hasPermission('flows.publish'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const flow = await prisma.flow.findFirst({
      where: { id, orgId: req.orgId },
    });

    if (!flow) {
      throw new NotFoundError('Flow not found');
    }

    // Validate flow before publishing
    if (!flow.nodes || (flow.nodes as any[]).length === 0) {
      throw new BadRequestError('Flow must have at least one node');
    }

    const triggerNodes = (flow.nodes as any[]).filter((n) => n.type === 'trigger');
    if (triggerNodes.length !== 1) {
      throw new BadRequestError('Flow must have exactly one trigger node');
    }

    // Deactivate other flows with same trigger if needed
    if (flow.trigger === 'welcome') {
      await prisma.flow.updateMany({
        where: {
          orgId: req.orgId,
          trigger: 'welcome',
          isActive: true,
          id: { not: id },
        },
        data: { isActive: false },
      });
    }

    const updated = await prisma.flow.update({
      where: { id },
      data: {
        isActive: true,
        publishedAt: new Date(),
      },
    });

    // Clear cache
    await cache.delPattern(`flows:${req.orgId}:*`);

    logger.info(`Flow published: ${id}`, { name: flow.name });

    res.json({
      success: true,
      data: updated,
    });
  })
);

/**
 * POST /api/flows/:id/unpublish
 * Deactivate flow
 */
router.post(
  '/:id/unpublish',
  hasPermission('flows.publish'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const flow = await prisma.flow.update({
      where: { id, orgId: req.orgId },
      data: { isActive: false },
    });

    // Clear cache
    await cache.delPattern(`flows:${req.orgId}:*`);

    logger.info(`Flow unpublished: ${id}`);

    res.json({
      success: true,
      data: flow,
    });
  })
);

/**
 * POST /api/flows/:id/test
 * Test flow with phone number
 */
router.post(
  '/:id/test',
  hasPermission('flows.edit'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { phoneNumber, variables } = testFlowSchema.parse(req.body);

    const flow = await prisma.flow.findFirst({
      where: { id, orgId: req.orgId },
    });

    if (!flow) {
      throw new NotFoundError('Flow not found');
    }

    // Queue flow execution
    const { getQueue, QUEUE_NAMES } = await import('../../services/redis.service');
    const queue = getQueue(QUEUE_NAMES.WHATSAPP_RECEIVE);

    await queue.add('execute-flow', {
      orgId: req.orgId,
      flowId: id,
      phoneNumber,
      variables: variables || {},
      isTest: true,
    });

    logger.info(`Flow test queued: ${id}`, { phoneNumber });

    res.json({
      success: true,
      message: 'Flow test initiated. Check your WhatsApp.',
    });
  })
);

/**
 * POST /api/flows/:id/duplicate
 * Duplicate flow
 */
router.post(
  '/:id/duplicate',
  hasPermission('flows.create'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const original = await prisma.flow.findFirst({
      where: { id, orgId: req.orgId },
    });

    if (!original) {
      throw new NotFoundError('Flow not found');
    }

    const duplicate = await prisma.flow.create({
      data: {
        name: `${original.name} (Copy)`,
        description: original.description,
        nodes: original.nodes,
        edges: original.edges,
        trigger: original.trigger,
        triggerValue: original.triggerValue,
        isActive: false,
        orgId: req.orgId!,
        createdById: req.user!.id,
      },
    });

    logger.info(`Flow duplicated: ${id} -> ${duplicate.id}`);

    res.status(201).json({
      success: true,
      data: duplicate,
    });
  })
);

/**
 * GET /api/flows/:id/analytics
 * Get flow execution analytics
 */
router.get(
  '/:id/analytics',
  hasPermission('flows.view'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { days = '7' } = req.query;

    const daysNum = parseInt(days as string);
    const since = new Date();
    since.setDate(since.getDate() - daysNum);

    const flow = await prisma.flow.findFirst({
      where: { id, orgId: req.orgId },
    });

    if (!flow) {
      throw new NotFoundError('Flow not found');
    }

    const [totalExecutions, completedExecutions, failedExecutions, executionsByDay] = await Promise.all([
      prisma.flowExecution.count({
        where: { flowId: id, createdAt: { gte: since } },
      }),
      prisma.flowExecution.count({
        where: { flowId: id, status: 'COMPLETED', createdAt: { gte: since } },
      }),
      prisma.flowExecution.count({
        where: { flowId: id, status: 'FAILED', createdAt: { gte: since } },
      }),
      prisma.$queryRaw`
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM flow_executions
        WHERE flow_id = ${id} AND created_at >= ${since}
        GROUP BY DATE(created_at)
        ORDER BY date ASC
      `,
    ]);

    res.json({
      success: true,
      data: {
        totalExecutions,
        completedExecutions,
        failedExecutions,
        completionRate: totalExecutions > 0? (completedExecutions / totalExecutions) * 100 : 0,
        executionsByDay,
      },
    });
  })
);

export default router;