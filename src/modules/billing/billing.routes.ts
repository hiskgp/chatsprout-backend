import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../middleware/auth';
import { hasPermission } from '../../middleware/rbac';
import { asyncHandler } from '../../middleware/error';
import { prisma } from '../../utils/prisma';
import { BadRequestError, NotFoundError } from '../../utils/errors';
import { logger } from '../../utils/logger';

const router = Router();

// All billing routes require authentication
router.use(authMiddleware);

// Validation schemas
const createCheckoutSchema = z.object({
  planId: z.enum(['STARTER', 'GROWTH', 'ENTERPRISE']),
  billingCycle: z.enum(['monthly', 'yearly']).default('monthly'),
});

const updateSubscriptionSchema = z.object({
  planId: z.enum(['STARTER', 'GROWTH', 'ENTERPRISE']).optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED']).optional(),
});

// Plan pricing config
const PLANS = {
  STARTER: {
    name: 'Starter',
    price: { monthly: 49, yearly: 470 },
    features: {
      contacts: 1000,
      messages: 5000,
      users: 3,
      flows: 10,
      campaigns: 20,
      aiCredits: 1000,
    },
  },
  GROWTH: {
    name: 'Growth',
    price: { monthly: 149, yearly: 1430 },
    features: {
      contacts: 10000,
      messages: 50000,
      users: 10,
      flows: 50,
      campaigns: 100,
      aiCredits: 10000,
    },
  },
  ENTERPRISE: {
    name: 'Enterprise',
    price: { monthly: 499, yearly: 4790 },
    features: {
      contacts: -1, // unlimited
      messages: -1,
      users: -1,
      flows: -1,
      campaigns: -1,
      aiCredits: -1,
    },
  },
};

/**
 * GET /api/billing/subscription
 * Get current organization subscription
 */
router.get(
  '/subscription',
  hasPermission('billing.view'),
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUnique({
      where: { id: req.orgId },
      select: {
        id: true,
        name: true,
        plan: true,
        subscriptionStatus: true,
        trialEndsAt: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        currentPeriodEnd: true,
        limits: true,
      },
    });

    if (!org) {
      throw new NotFoundError('Organization not found');
    }

    // Check if trial expired
    const isTrialExpired = org.trialEndsAt && new Date() > org.trialEndsAt;
    const daysLeftInTrial = org.trialEndsAt
      ? Math.max(0, Math.ceil((org.trialEndsAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : 0;

    res.json({
      success: true,
      data: {
        ...org,
        planDetails: PLANS[org.plan as keyof typeof PLANS],
        isTrialExpired,
        daysLeftInTrial,
        isActive: org.subscriptionStatus === 'ACTIVE' || (!isTrialExpired && org.subscriptionStatus === 'TRIAL'),
      },
    });
  })
);

/**
 * GET /api/billing/plans
 * Get all available plans
 */
router.get(
  '/plans',
  hasPermission('billing.view'),
  asyncHandler(async (req, res) => {
    const currentOrg = await prisma.organization.findUnique({
      where: { id: req.orgId },
      select: { plan: true },
    });

    const plans = Object.entries(PLANS).map(([key, plan]) => ({
      id: key,
      ...plan,
      isCurrent: currentOrg?.plan === key,
    }));

    res.json({
      success: true,
      data: plans,
    });
  })
);

/**
 * POST /api/billing/checkout
 * Create Stripe checkout session for subscription
 */
router.post(
  '/checkout',
  hasPermission('billing.manage'),
  asyncHandler(async (req, res) => {
    const { planId, billingCycle } = createCheckoutSchema.parse(req.body);

    const org = await prisma.organization.findUnique({
      where: { id: req.orgId },
    });

    if (!org) {
      throw new NotFoundError('Organization not found');
    }

    if (org.plan === planId && org.subscriptionStatus === 'ACTIVE') {
      throw new BadRequestError('Already subscribed to this plan');
    }

    // Get Stripe price ID from env
    const priceId = process.env[`STRIPE_PRICE_${planId}_${billingCycle.toUpperCase()}`];
    if (!priceId) {
      throw new BadRequestError('Stripe price not configured for this plan');
    }

    // Import Stripe dynamically to avoid issues if not configured
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2023-10-16',
    });

    // Create or get Stripe customer
    let customerId = org.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user!.email,
        name: org.name,
        metadata: {
          orgId: org.id,
        },
      });
      customerId = customer.id;

      await prisma.organization.update({
        where: { id: req.orgId },
        data: { stripeCustomerId: customerId },
      });
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/billing/cancel`,
      metadata: {
        orgId: req.orgId,
        planId,
        billingCycle,
      },
    });

    logger.info(`Checkout session created`, {
      orgId: req.orgId,
      planId,
      billingCycle,
      sessionId: session.id,
    });

    res.json({
      success: true,
      data: {
        checkoutUrl: session.url,
        sessionId: session.id,
      },
    });
  })
);

/**
 * POST /api/billing/portal
 * Create Stripe customer portal session
 */
router.post(
  '/portal',
  hasPermission('billing.manage'),
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUnique({
      where: { id: req.orgId },
      select: { stripeCustomerId: true },
    });

    if (!org?.stripeCustomerId) {
      throw new BadRequestError('No Stripe customer found. Please subscribe first.');
    }

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2023-10-16',
    });

    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripeCustomerId,
      return_url: `${process.env.FRONTEND_URL}/billing`,
    });

    res.json({
      success: true,
      data: {
        portalUrl: session.url,
      },
    });
  })
);

/**
 * POST /api/billing/cancel
 * Cancel subscription at period end
 */
router.post(
  '/cancel',
  hasPermission('billing.manage'),
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUnique({
      where: { id: req.orgId },
    });

    if (!org?.stripeSubscriptionId) {
      throw new BadRequestError('No active subscription found');
    }

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2023-10-16',
    });

    // Cancel at period end
    const subscription = await stripe.subscriptions.update(org.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    await prisma.organization.update({
      where: { id: req.orgId },
      data: {
        subscriptionStatus: 'CANCELLED',
        cancelAtPeriodEnd: true,
      },
    });

    logger.info(`Subscription cancelled`, {
      orgId: req.orgId,
      subscriptionId: org.stripeSubscriptionId,
      userId: req.userId,
    });

    res.json({
      success: true,
      data: {
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      },
      message: 'Subscription will be cancelled at the end of billing period',
    });
  })
);

/**
 * POST /api/billing/reactivate
 * Reactivate cancelled subscription
 */
router.post(
  '/reactivate',
  hasPermission('billing.manage'),
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUnique({
      where: { id: req.orgId },
    });

    if (!org?.stripeSubscriptionId) {
      throw new BadRequestError('No subscription found');
    }

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2023-10-16',
    });

    const subscription = await stripe.subscriptions.update(org.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });

    await prisma.organization.update({
      where: { id: req.orgId },
      data: {
        subscriptionStatus: 'ACTIVE',
        cancelAtPeriodEnd: false,
      },
    });

    logger.info(`Subscription reactivated`, {
      orgId: req.orgId,
      userId: req.userId,
    });

    res.json({
      success: true,
      data: {
        status: 'ACTIVE',
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      },
      message: 'Subscription reactivated successfully',
    });
  })
);

/**
 * GET /api/billing/invoices
 * Get billing history
 */
router.get(
  '/invoices',
  hasPermission('billing.view'),
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUnique({
      where: { id: req.orgId },
      select: { stripeCustomerId: true },
    });

    if (!org?.stripeCustomerId) {
      return res.json({
        success: true,
        data: [],
      });
    }

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2023-10-16',
    });

    const invoices = await stripe.invoices.list({
      customer: org.stripeCustomerId,
      limit: 20,
    });

    const formattedInvoices = invoices.data.map((inv) => ({
      id: inv.id,
      number: inv.number,
      amount: inv.amount_paid / 100,
      currency: inv.currency,
      status: inv.status,
      date: new Date(inv.created * 1000),
      invoicePdf: inv.invoice_pdf,
      hostedInvoiceUrl: inv.hosted_invoice_url,
    }));

    res.json({
      success: true,
      data: formattedInvoices,
    });
  })
);

/**
 * GET /api/billing/usage
 * Get current usage stats
 */
router.get(
  '/usage',
  hasPermission('billing.view'),
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUnique({
      where: { id: req.orgId },
      select: {
        plan: true,
        limits: true,
      },
    });

    if (!org) {
      throw new NotFoundError('Organization not found');
    }

    const planLimits = PLANS[org.plan as keyof typeof PLANS].features;

    // Get current month usage
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [contactsCount, messagesCount, usersCount, flowsCount, campaignsCount] = await Promise.all([
      prisma.contact.count({ where: { orgId: req.orgId } }),
      prisma.message.count({
        where: {
          orgId: req.orgId,
          direction: 'OUTBOUND',
          createdAt: { gte: startOfMonth },
        },
      }),
      prisma.user.count({ where: { orgId: req.orgId } }),
      prisma.flow.count({ where: { orgId: req.orgId } }),
      prisma.campaign.count({ where: { orgId: req.orgId } }),
    ]);

    const usage = {
      contacts: {
        used: contactsCount,
        limit: planLimits.contacts,
        percentage: planLimits.contacts === -1 ? 0 : (contactsCount / planLimits.contacts) * 100,
      },
      messages: {
        used: messagesCount,
        limit: planLimits.messages,
        percentage: planLimits.messages === -1 ? 0 : (messagesCount / planLimits.messages) * 100,
      },
      users: {
        used: usersCount,
        limit: planLimits.users,
        percentage: planLimits.users === -1 ? 0 : (usersCount / planLimits.users) * 100,
      },
      flows: {
        used: flowsCount,
        limit: planLimits.flows,
        percentage: planLimits.flows === -1 ? 0 : (flowsCount / planLimits.flows) * 100,
      },
      campaigns: {
        used: campaignsCount,
        limit: planLimits.campaigns,
        percentage: planLimits.campaigns === -1 ? 0 : (campaignsCount / planLimits.campaigns) * 100,
      },
    };

    res.json({
      success: true,
      data: {
        plan: org.plan,
        usage,
        periodStart: startOfMonth,
        periodEnd: new Date(startOfMonth.getFullYear(), startOfMonth.getMonth() + 1, 0),
      },
    });
  })
);

/**
 * POST /api/billing/webhook
 * Stripe webhook handler - PUBLIC endpoint
 */
router.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    const sig = req.headers['stripe-signature'] as string;

    if (!sig) {
      throw new BadRequestError('Missing stripe signature');
    }

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2023-10-16',
    });

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
    } catch (err: any) {
      logger.error('Stripe webhook signature verification failed:', err.message);
      throw new BadRequestError(`Webhook Error: ${err.message}`);
    }

    logger.info(`Stripe webhook received: ${event.type}`);

    // Handle events
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as any;
        const { orgId, planId, billingCycle } = session.metadata;

        await prisma.organization.update({
          where: { id: orgId },
          data: {
            plan: planId,
            subscriptionStatus: 'ACTIVE',
            stripeSubscriptionId: session.subscription,
            currentPeriodEnd: new Date(session.expires_at * 1000),
            limits: PLANS[planId as keyof typeof PLANS].features,
          },
        });

        logger.info(`Subscription activated via webhook`, { orgId, planId });
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as any;
        const orgId = subscription.metadata.orgId;

        await prisma.organization.update({
          where: { id: orgId },
          data: {
            subscriptionStatus: subscription.status.toUpperCase(),
            currentPeriodEnd: new Date(subscription.current_period_end * 1000),
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
          },
        });

        logger.info(`Subscription updated via webhook`, { orgId, status: subscription.status });
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as any;
        const orgId = subscription.metadata.orgId;

        await prisma.organization.update({
          where: { id: orgId },
          data: {
            subscriptionStatus: 'CANCELLED',
            plan: 'STARTER', // Downgrade to free
            limits: PLANS.STARTER.features,
          },
        });

        logger.info(`Subscription cancelled via webhook`, { orgId });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as any;
        const customerId = invoice.customer;

        const org = await prisma.organization.findFirst({
          where: { stripeCustomerId: customerId },
        });

        if (org) {
          await prisma.organization.update({
            where: { id: org.id },
            data: { subscriptionStatus: 'PAST_DUE' },
          });

          logger.warn(`Payment failed for org`, { orgId: org.id });
        }
        break;
      }

      default:
        logger.debug(`Unhandled Stripe event: ${event.type}`);
    }

    res.json({ received: true });
  })
);

export default router;