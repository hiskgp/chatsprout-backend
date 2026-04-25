import { Request, Response, NextFunction } from 'express';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import { asyncHandler } from './error';

// Define role hierarchy - higher number = more permissions
const ROLE_HIERARCHY = {
  VIEWER: 1,
  AGENT: 2,
  ADMIN: 3,
  OWNER: 4,
} as const;

type Role = keyof typeof ROLE_HIERARCHY;

// Define feature permissions matrix
const FEATURE_PERMISSIONS: Record<string, Role[]> = {
  // User Management
  'users.create': ['OWNER', 'ADMIN'],
  'users.delete': ['OWNER'],
  'users.update': ['OWNER', 'ADMIN'],
  'users.view': ['OWNER', 'ADMIN', 'AGENT', 'VIEWER'],

  // Inbox & Messages
  'inbox.send_message': ['OWNER', 'ADMIN', 'AGENT'],
  'inbox.assign_conversation': ['OWNER', 'ADMIN', 'AGENT'],
  'inbox.close_conversation': ['OWNER', 'ADMIN', 'AGENT'],
  'inbox.view_all': ['OWNER', 'ADMIN'],
  'inbox.view_assigned': ['AGENT'],

  // Contacts
  'contacts.create': ['OWNER', 'ADMIN', 'AGENT'],
  'contacts.delete': ['OWNER', 'ADMIN'],
  'contacts.export': ['OWNER', 'ADMIN'],
  'contacts.import': ['OWNER', 'ADMIN'],

  // Flows
  'flows.create': ['OWNER', 'ADMIN'],
  'flows.edit': ['OWNER', 'ADMIN'],
  'flows.delete': ['OWNER', 'ADMIN'],
  'flows.publish': ['OWNER', 'ADMIN'],
  'flows.view': ['OWNER', 'ADMIN', 'AGENT', 'VIEWER'],

  // Campaigns
  'campaigns.create': ['OWNER', 'ADMIN'],
  'campaigns.send': ['OWNER', 'ADMIN'],
  'campaigns.delete': ['OWNER', 'ADMIN'],
  'campaigns.view': ['OWNER', 'ADMIN', 'AGENT', 'VIEWER'],

  // Templates
  'templates.create': ['OWNER', 'ADMIN'],
  'templates.approve': ['OWNER', 'ADMIN'],
  'templates.delete': ['OWNER', 'ADMIN'],
  'templates.view': ['OWNER', 'ADMIN', 'AGENT', 'VIEWER'],

  // Catalog & Orders
  'catalog.create': ['OWNER', 'ADMIN'],
  'catalog.edit': ['OWNER', 'ADMIN'],
  'catalog.delete': ['OWNER', 'ADMIN'],
  'orders.update_status': ['OWNER', 'ADMIN', 'AGENT'],
  'orders.refund': ['OWNER', 'ADMIN'],

  // Billing
  'billing.view': ['OWNER', 'ADMIN'],
  'billing.update': ['OWNER'],
  'billing.cancel_subscription': ['OWNER'],

  // Settings
  'settings.whatsapp': ['OWNER', 'ADMIN'],
  'settings.ai': ['OWNER', 'ADMIN'],
  'settings.integrations': ['OWNER', 'ADMIN'],
  'settings.webhooks': ['OWNER', 'ADMIN'],

  // Analytics
  'analytics.view': ['OWNER', 'ADMIN', 'AGENT', 'VIEWER'],
  'analytics.export': ['OWNER', 'ADMIN'],
};

/**
 * Check if user has required role level
 * Higher roles inherit lower role permissions
 */
export const hasRoleLevel = (userRole: string, requiredRole: Role): boolean => {
  const userLevel = ROLE_HIERARCHY[userRole as Role] || 0;
  const requiredLevel = ROLE_HIERARCHY[requiredRole];
  return userLevel >= requiredLevel;
};

/**
 * Check if user has permission for specific feature
 * Usage: router.post('/', authMiddleware, hasPermission('flows.create'), handler)
 */
export const hasPermission = (feature: string) => {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }

    const { role, orgId } = req.user;
    const allowedRoles = FEATURE_PERMISSIONS[feature];

    if (!allowedRoles) {
      logger.warn(`Unknown feature permission check: ${feature}`);
      throw new ForbiddenError('Feature not found');
    }

    // Check if user's role is in allowed roles
    if (!allowedRoles.includes(role as Role)) {
      logger.warn(`Permission denied: ${req.user.email} tried to access ${feature}`, {
        userRole: role,
        requiredRoles: allowedRoles,
        orgId,
      });
      throw new ForbiddenError(
        `You don't have permission to access ${feature}. Required: ${allowedRoles.join(' or ')}`
      );
    }

    // Check org-level feature flags from database
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { plan: true, status: true },
    });

    if (!org) {
      throw new ForbiddenError('Organization not found');
    }

    if (org.status!== 'ACTIVE') {
      throw new ForbiddenError('Organization is inactive');
    }

    // Check plan-based feature access
    if (feature.startsWith('analytics.') && org.plan === 'FREE') {
      throw new ForbiddenError('Analytics requires PRO or ENTERPRISE plan');
    }

    if (feature.startsWith('voice.') && org.plan === 'FREE') {
      throw new ForbiddenError('Voice features require PRO or ENTERPRISE plan');
    }

    next();
  });
};

/**
 * Check if user owns the resource or has admin rights
 * Use for routes like /api/contacts/:id
 * Verifies resource.orgId === req.user.orgId
 */
export const requireResourceOwnership = (resourceType: 'contact' | 'conversation' | 'flow' | 'campaign') => {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }

    const resourceId = req.params.id;
    if (!resourceId) {
      throw new ForbiddenError('Resource ID missing');
    }

    // Admins and Owners can access any resource in their org
    if (req.user.role === 'OWNER' || req.user.role === 'ADMIN') {
      return next();
    }

    // For Agents, check specific ownership
    let resource;
    switch (resourceType) {
      case 'contact':
        resource = await prisma.contact.findUnique({
          where: { id: resourceId },
          select: { orgId: true, assignedToId: true },
        });
        break;

      case 'conversation':
        resource = await prisma.conversation.findUnique({
          where: { id: resourceId },
          select: { orgId: true, assignedToId: true },
        });
        break;

      case 'flow':
        resource = await prisma.flow.findUnique({
          where: { id: resourceId },
          select: { orgId: true, createdById: true },
        });
        break;

      case 'campaign':
        resource = await prisma.campaign.findUnique({
          where: { id: resourceId },
          select: { orgId: true, createdById: true },
        });
        break;
    }

    if (!resource) {
      throw new ForbiddenError('Resource not found');
    }

    if (resource.orgId!== req.user.orgId) {
      throw new ForbiddenError('Resource belongs to different organization');
    }

    // Check assignment for conversations/contacts
    if ('assignedToId' in resource && resource.assignedToId!== req.user.id) {
      throw new ForbiddenError('Resource not assigned to you');
    }

    // Check ownership for flows/campaigns
    if ('createdById' in resource && resource.createdById!== req.user.id) {
      throw new ForbiddenError('You can only access resources you created');
    }

    next();
  });
};

/**
 * Check organization feature flag
 * Verifies if org has specific feature enabled
 */
export const requireOrgFeature = (feature: string) => {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.orgId) {
      throw new UnauthorizedError('Organization context required');
    }

    const org = await prisma.organization.findUnique({
      where: { id: req.orgId },
      select: { plan: true, status: true },
    });

    if (!org || org.status!== 'ACTIVE') {
      throw new ForbiddenError('Organization inactive');
    }

    // Map features to plan requirements
    const planFeatures: Record<string, string[]> = {
      FREE: ['inbox', 'contacts'],
      PRO: ['inbox', 'contacts', 'flows', 'campaigns', 'templates', 'analytics'],
      ENTERPRISE: ['inbox', 'contacts', 'flows', 'campaigns', 'templates', 'analytics', 'voice', 'api'],
    };

    const allowedFeatures = planFeatures[org.plan] || [];

    if (!allowedFeatures.includes(feature)) {
      throw new ForbiddenError(
        `Feature '${feature}' requires upgrade. Current plan: ${org.plan}`
      );
    }

    next();
  });
};

/**
 * Rate limit by role
 * Different limits for different roles
 */
export const roleBasedRateLimit = () => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next();
    }

    // Set rate limit headers based on role
    const limits = {
      OWNER: 10000,
      ADMIN: 5000,
      AGENT: 2000,
      VIEWER: 1000,
    };

    const limit = limits[req.user.role as Role] || 100;
    res.setHeader('X-RateLimit-Limit', limit.toString());
    res.setHeader('X-RateLimit-Role', req.user.role);

    next();
  };
};