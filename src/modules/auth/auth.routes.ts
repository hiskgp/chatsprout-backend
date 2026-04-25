import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { authMiddleware, AuthRequest } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/error';
import { prisma } from '../../utils/prisma';
import { cache, rateLimiter } from '../../services/redis.service';
import { BadRequestError, UnauthorizedError, ConflictError, NotFoundError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { getQueue, QUEUE_NAMES } from '../../services/redis.service';

const router = Router();

// Validation schemas
const registerSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(100),
  name: z.string().min(2).max(100),
  orgName: z.string().min(2).max(100),
  phone: z.string().regex(/^\+?[1-9]\d{1,14}$/).optional(),
});

const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string(),
});

const forgotPasswordSchema = z.object({
  email: z.string().email().toLowerCase(),
});

const resetPasswordSchema = z.object({
  token: z.string(),
  password: z.string().min(8).max(100),
});

const updateProfileSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  phone: z.string().regex(/^\+?[1-9]\d{1,14}$/).optional().nullable(),
  avatar: z.string().url().optional().nullable(),
});

/**
 * Generate JWT tokens
 */
const generateTokens = (userId: string, orgId: string, role: string) => {
  const accessToken = jwt.sign(
    { userId, orgId, role },
    process.env.JWT_SECRET!,
    { expiresIn: '15m' }
  );

  const refreshToken = jwt.sign(
    { userId, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET!,
    { expiresIn: '7d' }
  );

  return { accessToken, refreshToken };
};

/**
 * POST /api/auth/register
 * Register new user + organization
 */
router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const validated = registerSchema.parse(req.body);

    // Rate limit: 5 registrations per IP per hour
    const ipKey = `ratelimit:register:${req.ip}`;
    const { allowed } = await rateLimiter.check(ipKey, 5, 3600);
    if (!allowed) {
      throw new BadRequestError('Too many registration attempts. Try again later');
    }

    // Check if email exists
    const existing = await prisma.user.findUnique({
      where: { email: validated.email },
    });

    if (existing) {
      throw new ConflictError('Email already registered');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(validated.password, 12);

    // Create org + user in transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create organization
      const org = await tx.organization.create({
        data: {
          name: validated.orgName,
          plan: 'FREE',
          status: 'ACTIVE',
        },
      });

      // Create user as OWNER
      const user = await tx.user.create({
        data: {
          email: validated.email,
          password: hashedPassword,
          name: validated.name,
          phone: validated.phone,
          role: 'OWNER',
          orgId: org.id,
          emailVerified: false,
        },
      });

      return { org, user };
    });

    // Generate email verification token
    const verifyToken = crypto.randomBytes(32).toString('hex');
    await cache.set(`verify:${verifyToken}`, result.user.id, 86400); // 24 hours

    // Queue verification email
    const emailQueue = getQueue(QUEUE_NAMES.WHATSAPP_SEND);
    await emailQueue.add('send-email', {
      to: validated.email,
      type: 'verify-email',
      data: {
        name: validated.name,
        token: verifyToken,
      },
    });

    // Generate tokens
    const tokens = generateTokens(result.user.id, result.org.id, result.user.role);

    logger.info(`User registered: ${result.user.id}`, { email: validated.email, orgId: result.org.id });

    res.status(201).json({
      success: true,
      data: {
        user: {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
          role: result.user.role,
          emailVerified: result.user.emailVerified,
        },
        organization: {
          id: result.org.id,
          name: result.org.name,
          plan: result.org.plan,
        },
        tokens,
      },
      message: 'Registration successful. Please verify your email',
    });
  })
);

/**
 * POST /api/auth/login
 * Login with email + password
 */
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const validated = loginSchema.parse(req.body);

    // Rate limit: 10 login attempts per email per 15 minutes
    const rateLimitKey = `ratelimit:login:${validated.email}`;
    const { allowed, remaining } = await rateLimiter.check(rateLimitKey, 10, 900);
    if (!allowed) {
      throw new UnauthorizedError('Too many login attempts. Try again in 15 minutes');
    }

    // Find user
    const user = await prisma.user.findUnique({
      where: { email: validated.email },
      include: { organization: true },
    });

    if (!user) {
      throw new UnauthorizedError('Invalid email or password');
    }

    // Check password
    const isValid = await bcrypt.compare(validated.password, user.password);
    if (!isValid) {
      throw new UnauthorizedError('Invalid email or password');
    }

    // Check org status
    if (user.organization.status!== 'ACTIVE') {
      throw new ForbiddenError('Organization account is suspended');
    }

    // Generate tokens
    const tokens = generateTokens(user.id, user.orgId, user.role);

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    logger.info(`User logged in: ${user.id}`, { email: user.email });

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          avatar: user.avatar,
          emailVerified: user.emailVerified,
        },
        organization: {
          id: user.organization.id,
          name: user.organization.name,
          plan: user.organization.plan,
        },
        tokens,
      },
    });
  })
);

/**
 * POST /api/auth/refresh
 * Refresh access token
 */
router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      throw new BadRequestError('Refresh token required');
    }

    try {
      const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!) as any;

      if (decoded.type!== 'refresh') {
        throw new UnauthorizedError('Invalid token type');
      }

      // Get user
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        include: { organization: true },
      });

      if (!user || user.organization.status!== 'ACTIVE') {
        throw new UnauthorizedError('User not found or inactive');
      }

      // Generate new tokens
      const tokens = generateTokens(user.id, user.orgId, user.role);

      res.json({
        success: true,
        data: { tokens },
      });
    } catch (error) {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }
  })
);

/**
 * POST /api/auth/logout
 * Logout (client should delete tokens)
 */
router.post(
  '/logout',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res) => {
    // In a more complex setup, you'd blacklist the token in Redis
    // For now, client just deletes tokens

    logger.info(`User logged out: ${req.user!.id}`);

    res.json({
      success: true,
      message: 'Logged out successfully',
    });
  })
);

/**
 * POST /api/auth/forgot-password
 * Send password reset email
 */
router.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    const validated = forgotPasswordSchema.parse(req.body);

    // Rate limit: 3 requests per email per hour
    const rateLimitKey = `ratelimit:forgot:${validated.email}`;
    const { allowed } = await rateLimiter.check(rateLimitKey, 3, 3600);
    if (!allowed) {
      throw new BadRequestError('Too many password reset requests. Try again later');
    }

    const user = await prisma.user.findUnique({
      where: { email: validated.email },
    });

    // Always return success to prevent email enumeration
    if (!user) {
      logger.warn(`Password reset requested for non-existent email: ${validated.email}`);
      return res.json({
        success: true,
        message: 'If the email exists, a reset link has been sent',
      });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    await cache.set(`reset:${resetToken}`, user.id, 3600); // 1 hour

    // Queue reset email
    const emailQueue = getQueue(QUEUE_NAMES.WHATSAPP_SEND);
    await emailQueue.add('send-email', {
      to: validated.email,
      type: 'reset-password',
      data: {
        name: user.name,
        token: resetToken,
      },
    });

    logger.info(`Password reset requested: ${user.id}`);

    res.json({
      success: true,
      message: 'If the email exists, a reset link has been sent',
    });
  })
);

/**
 * POST /api/auth/reset-password
 * Reset password with token
 */
router.post(
  '/reset-password',
  asyncHandler(async (req, res) => {
    const validated = resetPasswordSchema.parse(req.body);

    // Get user ID from token
    const userId = await cache.get<string>(`reset:${validated.token}`);
    if (!userId) {
      throw new BadRequestError('Invalid or expired reset token');
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(validated.password, 12);

    // Update password
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    // Delete reset token
    await cache.del(`reset:${validated.token}`);

    logger.info(`Password reset: ${userId}`);

    res.json({
      success: true,
      message: 'Password reset successfully',
    });
  })
);

/**
 * POST /api/auth/verify-email/:token
 * Verify email address
 */
router.post(
  '/verify-email/:token',
  asyncHandler(async (req, res) => {
    const { token } = req.params;

    const userId = await cache.get<string>(`verify:${token}`);
    if (!userId) {
      throw new BadRequestError('Invalid or expired verification token');
    }

    await prisma.user.update({
      where: { id: userId },
      data: { emailVerified: true },
    });

    await cache.del(`verify:${token}`);

    logger.info(`Email verified: ${userId}`);

    res.json({
      success: true,
      message: 'Email verified successfully',
    });
  })
);

/**
 * GET /api/auth/me
 * Get current user profile
 */
router.get(
  '/me',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            plan: true,
            status: true,
            whatsappConnected: true,
            aiEnabled: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    res.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        avatar: user.avatar,
        role: user.role,
        emailVerified: user.emailVerified,
        organization: user.organization,
      },
    });
  })
);

/**
 * PATCH /api/auth/me
 * Update current user profile
 */
router.patch(
  '/me',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res) => {
    const validated = updateProfileSchema.parse(req.body);

    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: validated,
    });

    logger.info(`Profile updated: ${user.id}`);

    res.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        avatar: user.avatar,
      },
    });
  })
);

export default router;