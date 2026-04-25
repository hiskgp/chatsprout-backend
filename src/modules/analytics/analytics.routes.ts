import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import { hasPermission } from '../../middleware/rbac';
import { asyncHandler } from '../../middleware/error';
import { prisma } from '../../utils/prisma';
import { cache } from '../../services/redis.service';
import { BadRequestError } from '../../utils/errors';
import { logger } from '../../utils/logger';

const router = Router();

// All analytics routes require authentication
router.use(authMiddleware);

// Validation schemas
const dateRangeSchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  period: z.enum(['today', 'yesterday', '7d', '30d', '90d', 'custom']).default('7d'),
});

/**
 * Helper: Get date range from period
 */
const getDateRange = (period: string, startDate?: string, endDate?: string) => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (period) {
    case 'today':
      return {
        gte: today,
        lte: new Date(today.getTime() + 24 * 60 * 60 * 1000 - 1),
      };
    case 'yesterday':
      const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
      return {
        gte: yesterday,
        lte: new Date(yesterday.getTime() + 24 * 60 * 60 * 1000 - 1),
      };
    case '7d':
      return {
        gte: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000),
        lte: now,
      };
    case '30d':
      return {
        gte: new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000),
        lte: now,
      };
    case '90d':
      return {
        gte: new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000),
        lte: now,
      };
    case 'custom':
      if (!startDate ||!endDate) {
        throw new BadRequestError('startDate and endDate required for custom period');
      }
      return {
        gte: new Date(startDate),
        lte: new Date(endDate),
      };
    default:
      return {
        gte: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000),
        lte: now,
      };
  }
};

/**
 * GET /api/analytics/overview
 * Dashboard overview stats
 */
router.get(
  '/overview',
  hasPermission('analytics.view'),
  asyncHandler(async (req, res) => {
    const { period = '7d', startDate, endDate } = dateRangeSchema.parse(req.query);
    const dateRange = getDateRange(period, startDate, endDate);

    // Cache key
    const cacheKey = `analytics:overview:${req.orgId}:${period}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, cached: true });
    }

    const [
      totalContacts,
      totalConversations,
      messagesSent,
      messagesReceived,
      activeCampaigns,
      totalRevenue,
      newContacts,
    ] = await Promise.all([
      // Total contacts
      prisma.contact.count({
        where: { orgId: req.orgId },
      }),

      // Total conversations
      prisma.conversation.count({
        where: { orgId: req.orgId },
      }),

      // Messages sent in period
      prisma.message.count({
        where: {
          orgId: req.orgId,
          direction: 'OUTBOUND',
          createdAt: dateRange,
        },
      }),

      // Messages received in period
      prisma.message.count({
        where: {
          orgId: req.orgId,
          direction: 'INBOUND',
          createdAt: dateRange,
        },
      }),

      // Active campaigns
      prisma.campaign.count({
        where: {
          orgId: req.orgId,
          status: { in: ['RUNNING', 'SCHEDULED'] },
        },
      }),

      // Total revenue from orders
      prisma.order.aggregate({
        where: {
          orgId: req.orgId,
          status: 'COMPLETED',
          createdAt: dateRange,
        },
        _sum: { total: true },
      }),

      // New contacts in period
      prisma.contact.count({
        where: {
          orgId: req.orgId,
          createdAt: dateRange,
        },
      }),
    ]);

    // Calculate response rate
    const responseRate =
      messagesSent > 0? ((messagesReceived / messagesSent) * 100).toFixed(2) : '0';

    const data = {
      totalContacts,
      totalConversations,
      messagesSent,
      messagesReceived,
      activeCampaigns,
      totalRevenue: totalRevenue._sum.total || 0,
      newContacts,
      responseRate: parseFloat(responseRate),
      period,
      dateRange,
    };

    // Cache for 5 minutes
    await cache.set(cacheKey, data, 300);

    res.json({
      success: true,
      data,
    });
  })
);

/**
 * GET /api/analytics/messages
 * Message analytics with time series
 */
router.get(
  '/messages',
  hasPermission('analytics.view'),
  asyncHandler(async (req, res) => {
    const { period = '7d', startDate, endDate } = dateRangeSchema.parse(req.query);
    const dateRange = getDateRange(period, startDate, endDate);

    // Get messages grouped by day
    const messages = await prisma.$queryRawUnsafe<any[]>(
      `
      SELECT
        DATE(created_at) as date,
        direction,
        COUNT(*) as count
      FROM "Message"
      WHERE org_id = $1
        AND created_at >= $2
        AND created_at <= $3
      GROUP BY DATE(created_at), direction
      ORDER BY date ASC
    `,
      req.orgId,
      dateRange.gte,
      dateRange.lte
    );

    // Format data for charts
    const dateMap = new Map<string, { sent: number; received: number }>();

    messages.forEach((row) => {
      const dateStr = row.date.toISOString().split('T')[0];
      if (!dateMap.has(dateStr)) {
        dateMap.set(dateStr, { sent: 0, received: 0 });
      }
      const entry = dateMap.get(dateStr)!;
      if (row.direction === 'OUTBOUND') {
        entry.sent = Number(row.count);
      } else {
        entry.received = Number(row.count);
      }
    });

    const timeSeries = Array.from(dateMap.entries()).map(([date, counts]) => ({
      date,
      sent: counts.sent,
      received: counts.received,
    }));

    // Get message type breakdown
    const typeBreakdown = await prisma.message.groupBy({
      by: ['type'],
      where: {
        orgId: req.orgId,
        createdAt: dateRange,
      },
      _count: true,
    });

    res.json({
      success: true,
      data: {
        timeSeries,
        typeBreakdown: typeBreakdown.map((t) => ({
          type: t.type,
          count: t._count,
        })),
        period,
        dateRange,
      },
    });
  })
);

/**
 * GET /api/analytics/campaigns
 * Campaign performance analytics
 */
router.get(
  '/campaigns',
  hasPermission('analytics.view'),
  asyncHandler(async (req, res) => {
    const { period = '30d', startDate, endDate } = dateRangeSchema.parse(req.query);
    const dateRange = getDateRange(period, startDate, endDate);

    const campaigns = await prisma.campaign.findMany({
      where: {
        orgId: req.orgId,
        createdAt: dateRange,
      },
      select: {
        id: true,
        name: true,
        status: true,
        sentCount: true,
        deliveredCount: true,
        readCount: true,
        failedCount: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    // Calculate rates
    const campaignsWithRates = campaigns.map((c) => ({
    ...c,
      deliveryRate:
        c.sentCount > 0? ((c.deliveredCount / c.sentCount) * 100).toFixed(2) : '0',
      readRate:
        c.deliveredCount > 0? ((c.readCount / c.deliveredCount) * 100).toFixed(2) : '0',
      failureRate:
        c.sentCount > 0? ((c.failedCount / c.sentCount) * 100).toFixed(2) : '0',
    }));

    // Overall stats
    const totals = campaigns.reduce(
      (acc, c) => ({
        sent: acc.sent + c.sentCount,
        delivered: acc.delivered + c.deliveredCount,
        read: acc.read + c.readCount,
        failed: acc.failed + c.failedCount,
      }),
      { sent: 0, delivered: 0, read: 0, failed: 0 }
    );

    res.json({
      success: true,
      data: {
        campaigns: campaignsWithRates,
        totals: {
        ...totals,
          deliveryRate:
            totals.sent > 0? ((totals.delivered / totals.sent) * 100).toFixed(2) : '0',
          readRate:
            totals.delivered > 0? ((totals.read / totals.delivered) * 100).toFixed(2) : '0',
        },
        period,
      },
    });
  })
);

/**
 * GET /api/analytics/conversations
 * Conversation analytics
 */
router.get(
  '/conversations',
  hasPermission('analytics.view'),
  asyncHandler(async (req, res) => {
    const { period = '7d', startDate, endDate } = dateRangeSchema.parse(req.query);
    const dateRange = getDateRange(period, startDate, endDate);

    const [
      totalConversations,
      activeConversations,
      resolvedConversations,
      avgResponseTime,
      conversationsByStatus,
    ] = await Promise.all([
      // Total conversations in period
      prisma.conversation.count({
        where: {
          orgId: req.orgId,
          createdAt: dateRange,
        },
      }),

      // Active conversations
      prisma.conversation.count({
        where: {
          orgId: req.orgId,
          status: 'OPEN',
        },
      }),

      // Resolved conversations
      prisma.conversation.count({
        where: {
          orgId: req.orgId,
          status: 'RESOLVED',
          updatedAt: dateRange,
        },
      }),

      // Average response time - simplified calculation
      prisma.$queryRawUnsafe<any[]>(
        `
        SELECT AVG(EXTRACT(EPOCH FROM (m2.created_at - m1.created_at))) as avg_seconds
        FROM "Message" m1
        JOIN "Message" m2 ON m2.conversation_id = m1.conversation_id
        WHERE m1.org_id = $1
          AND m1.direction = 'INBOUND'
          AND m2.direction = 'OUTBOUND'
          AND m2.created_at > m1.created_at
          AND m1.created_at >= $2
          AND m1.created_at <= $3
        LIMIT 1
      `,
        req.orgId,
        dateRange.gte,
        dateRange.lte
      ),

      // Conversations by status
      prisma.conversation.groupBy({
        by: ['status'],
        where: {
          orgId: req.orgId,
          createdAt: dateRange,
        },
        _count: true,
      }),
    ]);

    const avgResponseMinutes = avgResponseTime[0]?.avg_seconds
    ? (avgResponseTime[0].avg_seconds / 60).toFixed(2)
      : '0';

    res.json({
      success: true,
      data: {
        totalConversations,
        activeConversations,
        resolvedConversations,
        avgResponseTimeMinutes: parseFloat(avgResponseMinutes),
        byStatus: conversationsByStatus.map((s) => ({
          status: s.status,
          count: s._count,
        })),
        period,
        dateRange,
      },
    });
  })
);

/**
 * GET /api/analytics/contacts
 * Contact growth analytics
 */
router.get(
  '/contacts',
  hasPermission('analytics.view'),
  asyncHandler(async (req, res) => {
    const { period = '30d', startDate, endDate } = dateRangeSchema.parse(req.query);
    const dateRange = getDateRange(period, startDate, endDate);

    // Contact growth over time
    const contactGrowth = await prisma.$queryRawUnsafe<any[]>(
      `
      SELECT
        DATE(created_at) as date,
        COUNT(*) as count
      FROM "Contact"
      WHERE org_id = $1
        AND created_at >= $2
        AND created_at <= $3
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `,
      req.orgId,
      dateRange.gte,
      dateRange.lte
    );

    // Contacts by tags
    const contactsByTags = await prisma.$queryRawUnsafe<any[]>(
      `
      SELECT
        tag,
        COUNT(*) as count
      FROM "Contact", UNNEST(tags) as tag
      WHERE org_id = $1
      GROUP BY tag
      ORDER BY count DESC
      LIMIT 10
    `,
      req.orgId
    );

    // Blocked contacts
    const blockedCount = await prisma.contact.count({
      where: {
        orgId: req.orgId,
        isBlocked: true,
      },
    });

    res.json({
      success: true,
      data: {
        growth: contactGrowth.map((g) => ({
          date: g.date.toISOString().split('T')[0],
          count: Number(g.count),
        })),
        byTags: contactsByTags.map((t) => ({
          tag: t.tag,
          count: Number(t.count),
        })),
        blockedCount,
        period,
        dateRange,
      },
    });
  })
);

/**
 * GET /api/analytics/revenue
 * Revenue analytics from orders
 */
router.get(
  '/revenue',
  hasPermission('analytics.view'),
  asyncHandler(async (req, res) => {
    const { period = '30d', startDate, endDate } = dateRangeSchema.parse(req.query);
    const dateRange = getDateRange(period, startDate, endDate);

    const [totalRevenue, orderCount, avgOrderValue, revenueByDay] = await Promise.all([
      // Total revenue
      prisma.order.aggregate({
        where: {
          orgId: req.orgId,
          status: 'COMPLETED',
          createdAt: dateRange,
        },
        _sum: { total: true },
      }),

      // Order count
      prisma.order.count({
        where: {
          orgId: req.orgId,
          status: 'COMPLETED',
          createdAt: dateRange,
        },
      }),

      // Average order value
      prisma.order.aggregate({
        where: {
          orgId: req.orgId,
          status: 'COMPLETED',
          createdAt: dateRange,
        },
        _avg: { total: true },
      }),

      // Revenue by day
      prisma.$queryRawUnsafe<any[]>(
        `
        SELECT
          DATE(created_at) as date,
          SUM(total) as revenue,
          COUNT(*) as orders
        FROM "Order"
        WHERE org_id = $1
          AND status = 'COMPLETED'
          AND created_at >= $2
          AND created_at <= $3
        GROUP BY DATE(created_at)
        ORDER BY date ASC
      `,
        req.orgId,
        dateRange.gte,
        dateRange.lte
      ),
    ]);

    res.json({
      success: true,
      data: {
        totalRevenue: totalRevenue._sum.total || 0,
        orderCount,
        avgOrderValue: avgOrderValue._avg.total || 0,
        timeSeries: revenueByDay.map((r) => ({
          date: r.date.toISOString().split('T')[0],
          revenue: Number(r.revenue),
          orders: Number(r.orders),
        })),
        period,
        dateRange,
      },
    });
  })
);

export default router;