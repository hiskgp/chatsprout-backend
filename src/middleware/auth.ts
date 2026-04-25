import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../utils/prisma';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';
import { logger } from '../utils/logger';
import { asyncHandler } from './error';

// Extend Express Request type to include user and orgId
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: string;
        orgId: string;
        name: string;
      };
      orgId?: string;
    }
  }
}

interface JwtPayload {
  userId: string;
  orgId: string;
  email: string;
  role: string;
  iat: number;
  exp: number;
}

/**
 * Authentication Middleware
 * Verifies JWT token and attaches user + orgId to request
 * Used on all protected /api routes
 */
export const authMiddleware = asyncHandler(
  async (req: Request, res: Response, next: NextFunction) => {
    // 1. Get token from header
    const authHeader = req.headers.authorization;

    if (!authHeader ||!authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('No token provided');
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      throw new UnauthorizedError('Invalid token format');
    }

    try {
      // 2. Verify JWT token
      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || 'wexo-secret-key-change-in-production'
      ) as JwtPayload;

      // 3. Check if user exists and is active
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          orgId: true,
          status: true,
        },
      });

      if (!user) {
        throw new UnauthorizedError('User not found');
      }

      if (user.status!== 'ACTIVE') {
        throw new UnauthorizedError('User account is inactive');
      }

      // 4. Verify orgId matches token (prevent token reuse across orgs)
      if (user.orgId!== decoded.orgId) {
        logger.warn('Token orgId mismatch', {
          userId: user.id,
          tokenOrgId: decoded.orgId,
          actualOrgId: user.orgId,
        });
        throw new UnauthorizedError('Token invalid for this organization');
      }

      // 5. Attach user and orgId to request
      req.user = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        orgId: user.orgId,
      };
      req.orgId = user.orgId;

      // 6. Log successful auth in development
      if (process.env.NODE_ENV === 'development') {
        logger.debug(`Auth success: ${user.email} (${user.role}) - Org: ${user.orgId}`);
      }

      next();
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedError('Token expired');
      }
      if (error instanceof jwt.JsonWebTokenError) {
        throw new UnauthorizedError('Invalid token');
      }
      throw error;
    }
  }
);

/**
 * Optional Auth Middleware
 * Attaches user if token exists, but doesn't fail if missing
 * Used for public routes that have extra features for logged-in users
 */
export const optionalAuthMiddleware = asyncHandler(
  async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader ||!authHeader.startsWith('Bearer ')) {
      // No token, continue without user
      return next();
    }

    try {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || 'wexo-secret-key-change-in-production'
      ) as JwtPayload;

      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          orgId: true,
          status: true,
        },
      });

      if (user && user.status === 'ACTIVE' && user.orgId === decoded.orgId) {
        req.user = {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          orgId: user.orgId,
        };
        req.orgId = user.orgId;
      }
    } catch (error) {
      // Ignore errors in optional auth, just continue without user
      logger.debug('Optional auth failed, continuing without user');
    }

    next();
  }
);

/**
 * Require specific role middleware
 * Use after authMiddleware
 * Example: router.post('/', authMiddleware, requireRole('ADMIN'), handler)
 */
export const requireRole = (...allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }

    if (!allowedRoles.includes(req.user.role)) {
      throw new ForbiddenError(
        `Requires role: ${allowedRoles.join(' or ')}. You are: ${req.user.role}`
      );
    }

    next();
  };
};

/**
 * Require owner role
 * Shortcut for requireRole('OWNER')
 */
export const requireOwner = requireRole('OWNER');

/**
 * Require admin or owner
 * Shortcut for requireRole('ADMIN', 'OWNER')
 */
export const requireAdmin = requireRole('ADMIN', 'OWNER');