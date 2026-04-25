import { Router } from 'express';
import { z } from 'zod';
import axios from 'axios';
import { authMiddleware } from '../../middleware/auth';
import { hasPermission } from '../../middleware/rbac';
import { asyncHandler } from '../../middleware/error';
import { prisma } from '../../utils/prisma';
import { cache } from '../../services/redis.service';
import { BadRequestError, NotFoundError, ForbiddenError } from '../../utils/errors';
import { logger } from '../../utils/logger';

const router = Router();

// All template routes require authentication
router.use(authMiddleware);

// Validation schemas
const templateComponentSchema = z.object({
  type: z.enum(['HEADER', 'BODY', 'FOOTER', 'BUTTONS']),
  format: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']).optional(),
  text: z.string().max(1024).optional(),
  example: z.object({
    header_text: z.array(z.string()).optional(),
    body_text: z.array(z.array(z.string())).optional(),
  }).optional(),
  buttons: z.array(z.object({
    type: z.enum(['QUICK_REPLY', 'URL', 'PHONE_NUMBER']),
    text: z.string().max(25),
    url: z.string().url().optional(),
    phone_number: z.string().optional(),
  })).optional(),
});

const createTemplateSchema = z.object({
  name: z.string().min(1).max(512).regex(/^[a-z0-9_]+$/, 'Only lowercase letters, numbers, and underscores'),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
  language: z.string().default('en'),
  components: z.array(templateComponentSchema).min(1),
});

const updateTemplateSchema = z.object({
  name: z.string().min(1).max(512).regex(/^[a-z0-9_]+$/).optional(),
  components: z.array(templateComponentSchema).optional(),
});

/**
 * GET /api/templates
 * Get all templates with filters
 */
router.get(
  '/',
  hasPermission('templates.view'),
  asyncHandler(async (req, res) => {
    const { status, category, language, search, page = '1', limit = '20' } = req.query;

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    const where: any = { orgId: req.orgId };

    if (status) {
      where.status = status;
    }

    if (category) {
      where.category = category;
    }

    if (language) {
      where.language = language;
    }

    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: 'insensitive' } },
        { category: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    const [templates, total] = await Promise.all([
      prisma.template.findMany({
        where,
        include: {
          createdBy: {
            select: { id: true, name: true, email: true },
          },
          _count: {
            select: { campaigns: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.template.count({ where }),
    ]);

    res.json({
      success: true,
      data: templates,
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
 * GET /api/templates/:id
 * Get single template with full details
 */
router.get(
  '/:id',
  hasPermission('templates.view'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const template = await prisma.template.findFirst({
      where: { id, orgId: req.orgId },
      include: {
        createdBy: {
          select: { id: true, name: true, email: true },
        },
        campaigns: {
          take: 5,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            name: true,
            status: true,
            sentCount: true,
            createdAt: true,
          },
        },
      },
    });

    if (!template) {
      throw new NotFoundError('Template not found');
    }

    res.json({
      success: true,
      data: template,
    });
  })
);

/**
 * POST /api/templates
 * Create new template and submit to WhatsApp for approval
 */
router.post(
  '/',
  hasPermission('templates.create'),
  asyncHandler(async (req, res) => {
    const validated = createTemplateSchema.parse(req.body);

    // Check for duplicate name in org
    const existing = await prisma.template.findFirst({
      where: {
        orgId: req.orgId,
        name: validated.name,
        language: validated.language,
      },
    });

    if (existing) {
      throw new BadRequestError('Template with this name and language already exists');
    }

    // Validate components
    const hasBody = validated.components.some((c) => c.type === 'BODY');
    if (!hasBody) {
      throw new BadRequestError('Template must have a BODY component');
    }

    // Get org WhatsApp config
    const org = await prisma.organization.findUnique({
      where: { id: req.orgId },
      select: {
        whatsappBusinessAccountId: true,
        whatsappAccessToken: true,
        whatsappApiVersion: true,
      },
    });

    if (!org?.whatsappBusinessAccountId || !org?.whatsappAccessToken) {
      throw new BadRequestError('WhatsApp not configured for this organization');
    }

    // Create template in database first (PENDING status)
    const template = await prisma.template.create({
      data: {
        name: validated.name,
        category: validated.category,
        language: validated.language,
        components: validated.components,
        status: 'PENDING',
        orgId: req.orgId!,
        createdById: req.user!.id,
      },
    });

    try {
      // Submit to WhatsApp for approval
      const whatsappResponse = await axios.post(
        `https://graph.facebook.com/${org.whatsappApiVersion || 'v18.0'}/${org.whatsappBusinessAccountId}/message_templates`,
        {
          name: validated.name,
          category: validated.category,
          language: validated.language,
          components: validated.components,
        },
        {
          headers: {
            Authorization: `Bearer ${org.whatsappAccessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Update with WhatsApp template ID
      await prisma.template.update({
        where: { id: template.id },
        data: {
          whatsappId: whatsappResponse.data.id,
          status: whatsappResponse.data.status || 'PENDING',
        },
      });

      logger.info(`Template submitted to WhatsApp: ${template.id}`, {
        name: validated.name,
        whatsappId: whatsappResponse.data.id,
      });

      res.status(201).json({
        success: true,
        data: {
         ...template,
          whatsappId: whatsappResponse.data.id,
          status: whatsappResponse.data.status || 'PENDING',
        },
        message: 'Template submitted for approval. Usually takes 1-2 minutes.',
      });
    } catch (error: any) {
      // If WhatsApp submission fails, delete the template
      await prisma.template.delete({ where: { id: template.id } });

      const errorMsg = error.response?.data?.error?.message || error.message;
      logger.error(`Template submission failed: ${template.id}`, errorMsg);
      throw new BadRequestError(`WhatsApp rejected template: ${errorMsg}`);
    }
  })
);

/**
 * PATCH /api/templates/:id
 * Update template (only DRAFT or REJECTED)
 */
router.patch(
  '/:id',
  hasPermission('templates.create'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const validated = updateTemplateSchema.parse(req.body);

    const existing = await prisma.template.findFirst({
      where: { id, orgId: req.orgId },
    });

    if (!existing) {
      throw new NotFoundError('Template not found');
    }

    if (existing.status === 'APPROVED') {
      throw new BadRequestError('Cannot edit approved template. Create a new one instead');
    }

    if (existing.status === 'PENDING') {
      throw new BadRequestError('Cannot edit template while pending approval');
    }

    // Check for name conflict if updating name
    if (validated.name && validated.name!== existing.name) {
      const duplicate = await prisma.template.findFirst({
        where: {
          orgId: req.orgId,
          name: validated.name,
          language: existing.language,
          id: { not: id },
        },
      });

      if (duplicate) {
        throw new BadRequestError('Template with this name already exists');
      }
    }

    const template = await prisma.template.update({
      where: { id },
      data: validated,
    });

    logger.info(`Template updated: ${id}`);

    res.json({
      success: true,
      data: template,
    });
  })
);

/**
 * DELETE /api/templates/:id
 * Delete template from WhatsApp and database
 */
router.delete(
  '/:id',
  hasPermission('templates.delete'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const template = await prisma.template.findFirst({
      where: { id, orgId: req.orgId },
      include: { _count: { select: { campaigns: true } } },
    });

    if (!template) {
      throw new NotFoundError('Template not found');
    }

    // Cannot delete if used in campaigns
    if (template._count.campaigns > 0) {
      throw new BadRequestError(`Template is used in ${template._count.campaigns} campaign(s). Delete campaigns first`);
    }

    // Delete from WhatsApp if it has whatsappId
    if (template.whatsappId) {
      const org = await prisma.organization.findUnique({
        where: { id: req.orgId },
        select: {
          whatsappBusinessAccountId: true,
          whatsappAccessToken: true,
          whatsappApiVersion: true,
        },
      });

      if (org?.whatsappAccessToken) {
        try {
          await axios.delete(
            `https://graph.facebook.com/${org.whatsappApiVersion || 'v18.0'}/${org.whatsappBusinessAccountId}/message_templates`,
            {
              headers: {
                Authorization: `Bearer ${org.whatsappAccessToken}`,
              },
              params: {
                name: template.name,
              },
            }
          );
          logger.info(`Template deleted from WhatsApp: ${template.whatsappId}`);
        } catch (error: any) {
          logger.error(`Failed to delete template from WhatsApp: ${template.whatsappId}`, error);
          // Continue with DB deletion even if WhatsApp fails
        }
      }
    }

    // Delete from database
    await prisma.template.delete({
      where: { id },
    });

    logger.info(`Template deleted: ${id}`);

    res.json({
      success: true,
      message: 'Template deleted successfully',
    });
  })
);

/**
 * POST /api/templates/:id/resubmit
 * Resubmit rejected template for approval
 */
router.post(
  '/:id/resubmit',
  hasPermission('templates.create'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const template = await prisma.template.findFirst({
      where: { id, orgId: req.orgId },
    });

    if (!template) {
      throw new NotFoundError('Template not found');
    }

    if (template.status!== 'REJECTED') {
      throw new BadRequestError('Only rejected templates can be resubmitted');
    }

    const org = await prisma.organization.findUnique({
      where: { id: req.orgId },
      select: {
        whatsappBusinessAccountId: true,
        whatsappAccessToken: true,
        whatsappApiVersion: true,
      },
    });

    if (!org?.whatsappBusinessAccountId || !org?.whatsappAccessToken) {
      throw new BadRequestError('WhatsApp not configured');
    }

    try {
      // Resubmit to WhatsApp
      const whatsappResponse = await axios.post(
        `https://graph.facebook.com/${org.whatsappApiVersion || 'v18.0'}/${org.whatsappBusinessAccountId}/message_templates`,
        {
          name: template.name,
          category: template.category,
          language: template.language,
          components: template.components,
        },
        {
          headers: {
            Authorization: `Bearer ${org.whatsappAccessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Update status
      await prisma.template.update({
        where: { id },
        data: {
          status: 'PENDING',
          whatsappId: whatsappResponse.data.id,
        },
      });

      logger.info(`Template resubmitted: ${id}`);

      res.json({
        success: true,
        message: 'Template resubmitted for approval',
      });
    } catch (error: any) {
      const errorMsg = error.response?.data?.error?.message || error.message;
      throw new BadRequestError(`WhatsApp rejected template: ${errorMsg}`);
    }
  })
);

/**
 * POST /api/templates/sync
 * Sync template status from WhatsApp
 */
router.post(
  '/sync',
  hasPermission('templates.view'),
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUnique({
      where: { id: req.orgId },
      select: {
        whatsappBusinessAccountId: true,
        whatsappAccessToken: true,
        whatsappApiVersion: true,
      },
    });

    if (!org?.whatsappBusinessAccountId || !org?.whatsappAccessToken) {
      throw new BadRequestError('WhatsApp not configured');
    }

    try {
      // Get all templates from WhatsApp
      const response = await axios.get(
        `https://graph.facebook.com/${org.whatsappApiVersion || 'v18.0'}/${org.whatsappBusinessAccountId}/message_templates`,
        {
          headers: {
            Authorization: `Bearer ${org.whatsappAccessToken}`,
          },
          params: {
            limit: 1000,
          },
        }
      );

      const whatsappTemplates = response.data.data || [];
      let updated = 0;

      // Update local templates with WhatsApp status
      for (const wt of whatsappTemplates) {
        const result = await prisma.template.updateMany({
          where: {
            orgId: req.orgId,
            name: wt.name,
            language: wt.language,
          },
          data: {
            status: wt.status,
            whatsappId: wt.id,
          },
        });
        updated += result.count;
      }

      logger.info(`Templates synced: ${updated} updated`);

      res.json({
        success: true,
        message: `${updated} templates synced`,
        data: { updated },
      });
    } catch (error: any) {
      logger.error('Template sync failed:', error);
      throw new BadRequestError('Failed to sync templates from WhatsApp');
    }
  })
);

/**
 * GET /api/templates/categories
 * Get template categories and their descriptions
 */
router.get(
  '/categories',
  hasPermission('templates.view'),
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      data: [
        {
          value: 'MARKETING',
          label: 'Marketing',
          description: 'Promotional messages, offers, product updates',
          examples: ['Sale announcements', 'New product launches', 'Discount codes'],
        },
        {
          value: 'UTILITY',
          label: 'Utility',
          description: 'Transactional messages, order updates, account alerts',
          examples: ['Order confirmations', 'Shipping updates', 'Appointment reminders'],
        },
        {
          value: 'AUTHENTICATION',
          label: 'Authentication',
          description: 'OTP codes, verification messages',
          examples: ['Login OTP', 'Account verification', 'Password reset'],
        },
      ],
    });
  })
);

export default router;