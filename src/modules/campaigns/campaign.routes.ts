import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import { hasPermission } from '../../middleware/rbac';
import { asyncHandler } from '../../middleware/error';
import { prisma } from '../../utils/prisma';
import { getQueue, QUEUE_NAMES } from '../../services/redis.service';
import { BadRequestError, NotFoundError, ForbiddenError } from '../../utils/errors';
import { logger } from '../../utils/logger';

const router = Router();

// All campaign routes require authentication
router.use(authMiddleware);

// Validation schemas
const createCampaignSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  templateId: z.string().uuid(),
  audienceType: z.enum(['all', 'tags', 'custom', 'csv']),
  audienceTags: z.array(z.string()).optional(),
  audienceIds: z.array(z.string().uuid()).optional(),
  scheduledAt: z.string().datetime().optional().nullable(),
  variables: z.record(z.string()).optional(),
});

const updateCampaignSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  status: z.enum(['DRAFT', 'SCHEDULED', 'CANCELLED']).optional(),
});

const testCampaignSchema = z.object({
  phoneNumbers: z.array(z.string().regex(/^\+?[1-9]\d{1,14}$/)).min(1).max(5),
  variables: z.record(z.string()).optional(),
});

/**
 * GET /api/campaigns
 * Get all campaigns with filters
 */
router.get(
  '/',
  hasPermission('campaigns.view'),
  asyncHandler(async (req, res) => {
    const { status, page = '1', limit = '20' } = req.query;

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    const where: any = { orgId: req.orgId };

    if (status) {
      where.status = status;
    }

    const [campaigns, total] = await Promise.all([
      prisma.campaign.findMany({
        where,
        include: {
          template: {
            select: { id: true, name: true, category: true, language: true },
          },
          createdBy: {
            select: { id: true, name: true, email: true },
          },
          _count: {
            select: { recipients: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.campaign.count({ where }),
    ]);

    res.json({
      success: true,
      data: campaigns,
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
 * GET /api/campaigns/:id
 * Get single campaign with details
 */
router.get(
  '/:id',
  hasPermission('campaigns.view'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const campaign = await prisma.campaign.findFirst({
      where: { id, orgId: req.orgId },
      include: {
        template: true,
        createdBy: {
          select: { id: true, name: true, email: true },
        },
        recipients: {
          take: 100,
          orderBy: { createdAt: 'desc' },
          include: {
            contact: {
              select: { id: true, name: true, phoneNumber: true },
            },
          },
        },
        _count: {
          select: { recipients: true },
        },
      },
    });

    if (!campaign) {
      throw new NotFoundError('Campaign not found');
    }

    res.json({
      success: true,
      data: campaign,
    });
  })
);

/**
 * POST /api/campaigns
 * Create new campaign
 */
router.post(
  '/',
  hasPermission('campaigns.create'),
  asyncHandler(async (req, res) => {
    const validated = createCampaignSchema.parse(req.body);

    // Verify template exists and is approved
    const template = await prisma.template.findFirst({
      where: {
        id: validated.templateId,
        orgId: req.orgId,
        status: 'APPROVED',
      },
    });

    if (!template) {
      throw new BadRequestError('Template not found or not approved');
    }

    // Get audience count based on type
    let audienceCount = 0;
    let contactIds: string[] = [];

    switch (validated.audienceType) {
      case 'all':
        const allContacts = await prisma.contact.findMany({
          where: { orgId: req.orgId, status: 'ACTIVE' },
          select: { id: true },
        });
        contactIds = allContacts.map((c) => c.id);
        audienceCount = contactIds.length;
        break;

      case 'tags':
        if (!validated.audienceTags || validated.audienceTags.length === 0) {
          throw new BadRequestError('Tags required for tag-based audience');
        }
        const taggedContacts = await prisma.contact.findMany({
          where: {
            orgId: req.orgId,
            status: 'ACTIVE',
            tags: { hasSome: validated.audienceTags },
          },
          select: { id: true },
        });
        contactIds = taggedContacts.map((c) => c.id);
        audienceCount = contactIds.length;
        break;

      case 'custom':
        if (!validated.audienceIds || validated.audienceIds.length === 0) {
          throw new BadRequestError('Contact IDs required for custom audience');
        }
        // Verify all contacts belong to org
        const customContacts = await prisma.contact.findMany({
          where: {
            id: { in: validated.audienceIds },
            orgId: req.orgId,
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        contactIds = customContacts.map((c) => c.id);
        audienceCount = contactIds.length;
        break;

      case 'csv':
        throw new BadRequestError('CSV upload not supported in this endpoint. Use /import');
    }

    if (audienceCount === 0) {
      throw new BadRequestError('No contacts found for selected audience');
    }

    if (audienceCount > 100000) {
      throw new BadRequestError('Maximum 100,000 recipients per campaign');
    }

    // Create campaign
    const campaign = await prisma.campaign.create({
      data: {
        name: validated.name,
        description: validated.description,
        templateId: validated.templateId,
        audienceType: validated.audienceType,
        audienceTags: validated.audienceTags || [],
        audienceCount,
        scheduledAt: validated.scheduledAt? new Date(validated.scheduledAt) : null,
        status: validated.scheduledAt? 'SCHEDULED' : 'DRAFT',
        orgId: req.orgId!,
        createdById: req.user!.id,
      },
    });

    // Create recipient records
    await prisma.campaignRecipient.createMany({
      data: contactIds.map((contactId) => ({
        campaignId: campaign.id,
        contactId,
        status: 'PENDING',
      })),
    });

    logger.info(`Campaign created: ${campaign.id}`, {
      name: campaign.name,
      audienceCount,
      status: campaign.status,
    });

    res.status(201).json({
      success: true,
      data: campaign,
    });
  })
);

/**
 * PATCH /api/campaigns/:id
 * Update campaign (only DRAFT or SCHEDULED)
 */
router.patch(
  '/:id',
  hasPermission('campaigns.create'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const validated = updateCampaignSchema.parse(req.body);

    const existing = await prisma.campaign.findFirst({
      where: { id, orgId: req.orgId },
    });

    if (!existing) {
      throw new NotFoundError('Campaign not found');
    }

    if (existing.status === 'SENDING' || existing.status === 'COMPLETED') {
      throw new BadRequestError('Cannot edit campaign that is sending or completed');
    }

    const campaign = await prisma.campaign.update({
      where: { id },
      data: {
       ...validated,
        scheduledAt: validated.scheduledAt? new Date(validated.scheduledAt) : validated.scheduledAt,
      },
    });

    logger.info(`Campaign updated: ${id}`);

    res.json({
      success: true,
      data: campaign,
    });
  })
);

/**
 * POST /api/campaigns/:id/send
 * Send campaign immediately
 */
router.post(
  '/:id/send',
  hasPermission('campaigns.send'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const campaign = await prisma.campaign.findFirst({
      where: { id, orgId: req.orgId },
      include: {
        recipients: {
          where: { status: 'PENDING' },
          select: { contactId: true },
        },
      },
    });

    if (!campaign) {
      throw new NotFoundError('Campaign not found');
    }

    if (campaign.status!== 'DRAFT' && campaign.status!== 'SCHEDULED') {
      throw new BadRequestError(`Cannot send campaign with status: ${campaign.status}`);
    }

    if (campaign.recipients.length === 0) {
      throw new BadRequestError('No pending recipients found');
    }

    // Update status to SENDING
    await prisma.campaign.update({
      where: { id },
      data: {
        status: 'SENDING',
        startedAt: new Date(),
      },
    });

    // Queue campaign send job
    const queue = getQueue(QUEUE_NAMES.CAMPAIGN_SEND);
    const contactIds = campaign.recipients.map((r) => r.contactId);

    await queue.add(
      'send-campaign',
      {
        orgId: req.orgId,
        campaignId: id,
        contactIds,
      },
      {
        priority: 1,
      }
    );

    logger.info(`Campaign send queued: ${id}`, { recipients: contactIds.length });

    res.json({
      success: true,
      message: `Campaign sending to ${contactIds.length} recipients`,
      data: { campaignId: id, recipients: contactIds.length },
    });
  })
);

/**
 * POST /api/campaigns/:id/cancel
 * Cancel scheduled or sending campaign
 */
router.post(
  '/:id/cancel',
  hasPermission('campaigns.delete'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const campaign = await prisma.campaign.findFirst({
      where: { id, orgId: req.orgId },
    });

    if (!campaign) {
      throw new NotFoundError('Campaign not found');
    }

    if (campaign.status!== 'SCHEDULED' && campaign.status!== 'SENDING') {
      throw new BadRequestError(`Cannot cancel campaign with status: ${campaign.status}`);
    }

    // Update status
    await prisma.campaign.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        completedAt: new Date(),
      },
    });

    // Cancel pending recipients
    await prisma.campaignRecipient.updateMany({
      where: {
        campaignId: id,
        status: 'PENDING',
      },
      data: { status: 'CANCELLED' },
    });

    logger.info(`Campaign cancelled: ${id}`);

    res.json({
      success: true,
      message: 'Campaign cancelled successfully',
    });
  })
);

/**
 * DELETE /api/campaigns/:id
 * Delete campaign (only DRAFT or CANCELLED)
 */
router.delete(
  '/:id',
  hasPermission('campaigns.delete'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const campaign = await prisma.campaign.findFirst({
      where: { id, orgId: req.orgId },
    });

    if (!campaign) {
      throw new NotFoundError('Campaign not found');
    }

    if (campaign.status === 'SENDING') {
      throw new BadRequestError('Cannot delete campaign that is currently sending');
    }

    if (campaign.status === 'COMPLETED') {
      throw new BadRequestError('Cannot delete completed campaign. Archive it instead');
    }

    await prisma.campaign.delete({
      where: { id },
    });

    logger.info(`Campaign deleted: ${id}`);

    res.json({
      success: true,
      message: 'Campaign deleted successfully',
    });
  })
);

/**
 * POST /api/campaigns/:id/test
 * Test campaign with specific phone numbers
 */
router.post(
  '/:id/test',
  hasPermission('campaigns.send'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { phoneNumbers, variables } = testCampaignSchema.parse(req.body);

    const campaign = await prisma.campaign.findFirst({
      where: { id, orgId: req.orgId },
      include: { template: true },
    });

    if (!campaign) {
      throw new NotFoundError('Campaign not found');
    }

    // Queue test messages
    const queue = getQueue(QUEUE_NAMES.WHATSAPP_SEND);

    for (const phoneNumber of phoneNumbers) {
      await queue.add('send-message', {
        orgId: req.orgId,
        payload: {
          to: phoneNumber,
          type: 'template',
          template: {
            name: campaign.template.name,
            language: { code: campaign.template.language },
            components: variables? [
              {
                type: 'body',
                parameters: Object.entries(variables).map(([key, value]) => ({
                  type: 'text',
                  text: value,
                })),
              },
            ] : [],
          },
        },
      });
    }

    logger.info(`Campaign test sent: ${id}`, { phoneNumbers });

    res.json({
      success: true,
      message: `Test messages sent to ${phoneNumbers.length} numbers`,
    });
  })
);

/**
 * GET /api/campaigns/:id/analytics
 * Get campaign analytics
 */
router.get(
  '/:id/analytics',
  hasPermission('campaigns.view'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const campaign = await prisma.campaign.findFirst({
      where: { id, orgId: req.orgId },
    });

    if (!campaign) {
      throw new NotFoundError('Campaign not found');
    }

    const [total, sent, delivered, read, failed, pending] = await Promise.all([
      prisma.campaignRecipient.count({ where: { campaignId: id } }),
      prisma.campaignRecipient.count({ where: { campaignId: id, status: 'SENT' } }),
      prisma.campaignRecipient.count({ where: { campaignId: id, status: 'DELIVERED' } }),
      prisma.campaignRecipient.count({ where: { campaignId: id, status: 'READ' } }),
      prisma.campaignRecipient.count({ where: { campaignId: id, status: 'FAILED' } }),
      prisma.campaignRecipient.count({ where: { campaignId: id, status: 'PENDING' } }),
    ]);

    res.json({
      success: true,
      data: {
        total,
        sent,
        delivered,
        read,
        failed,
        pending,
        deliveryRate: total > 0? (delivered / total) * 100 : 0,
        readRate: delivered > 0? (read / delivered) * 100 : 0,
        failureRate: total > 0? (failed / total) * 100 : 0,
      },
    });
  })
);

/**
 * POST /api/campaigns/:id/duplicate
 * Duplicate campaign
 */
router.post(
  '/:id/duplicate',
  hasPermission('campaigns.create'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const original = await prisma.campaign.findFirst({
      where: { id, orgId: req.orgId },
      include: { recipients: { select: { contactId: true } } },
    });

    if (!original) {
      throw new NotFoundError('Campaign not found');
    }

    const duplicate = await prisma.campaign.create({
      data: {
        name: `${original.name} (Copy)`,
        description: original.description,
        templateId: original.templateId,
        audienceType: original.audienceType,
        audienceTags: original.audienceTags,
        audienceCount: original.audienceCount,
        status: 'DRAFT',
        orgId: req.orgId!,
        createdById: req.user!.id,
      },
    });

    // Duplicate recipients
    await prisma.campaignRecipient.createMany({
      data: original.recipients.map((r) => ({
        campaignId: duplicate.id,
        contactId: r.contactId,
        status: 'PENDING',
      })),
    });

    logger.info(`Campaign duplicated: ${id} -> ${duplicate.id}`);

    res.status(201).json({
      success: true,
      data: duplicate,
    });
  })
);

export default router;