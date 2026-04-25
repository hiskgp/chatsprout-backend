import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error';
import { prisma } from '../../utils/prisma';
import { getQueue, QUEUE_NAMES } from '../../services/redis.service';
import { logger } from '../../utils/logger';
import { BadRequestError } from '../../utils/errors';

const router = Router();

// WhatsApp webhook payload validation
const webhookMessageSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          value: z.object({
            messaging_product: z.literal('whatsapp'),
            metadata: z.object({
              display_phone_number: z.string(),
              phone_number_id: z.string(),
            }),
            messages: z.array(z.any()).optional(),
            statuses: z.array(z.any()).optional(),
            contacts: z.array(z.any()).optional(),
          }),
          field: z.literal('messages'),
        })
      ),
    })
  ),
});

/**
 * Verify WhatsApp webhook signature
 */
const verifyWebhookSignature = (req: Request): boolean => {
  const signature = req.get('X-Hub-Signature-256');

  if (!signature) {
    logger.warn('Webhook signature missing');
    return false;
  }

  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    logger.error('WHATSAPP_APP_SECRET not configured');
    return false;
  }

  const payload = JSON.stringify(req.body);
  const expectedSignature = crypto
  .createHmac('sha256', appSecret)
  .update(payload)
  .digest('hex');

  const signatureHash = signature.replace('sha256=', '');

  if (!crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signatureHash))) {
    logger.warn('Webhook signature verification failed');
    return false;
  }

  return true;
};

/**
 * POST /webhook/whatsapp
 * Receive WhatsApp messages and status updates
 * NOTE: This endpoint is PUBLIC - no auth middleware
 */
router.post(
  '/whatsapp',
  asyncHandler(async (req: Request, res: Response) => {
    // 1. Verify signature for security
    if (process.env.NODE_ENV === 'production') {
      const isValid = verifyWebhookSignature(req);
      if (!isValid) {
        throw new BadRequestError('Invalid webhook signature');
      }
    }

    // 2. Validate payload structure
    const validated = webhookMessageSchema.parse(req.body);

    // 3. Process each entry
    for (const entry of validated.entry) {
      const businessAccountId = entry.id;

      for (const change of entry.changes) {
        const { metadata, messages, statuses, contacts } = change.value;
        const phoneNumberId = metadata.phone_number_id;

        // Find organization by phoneNumberId
        const org = await prisma.organization.findFirst({
          where: { whatsappPhoneNumberId: phoneNumberId },
          select: { id: true, status: true },
        });

        if (!org) {
          logger.warn(`Webhook received for unknown phoneNumberId: ${phoneNumberId}`);
          continue;
        }

        if (org.status!== 'ACTIVE') {
          logger.warn(`Webhook received for inactive org: ${org.id}`);
          continue;
        }

        // 4. Process incoming messages
        if (messages && messages.length > 0) {
          const queue = getQueue(QUEUE_NAMES.WHATSAPP_RECEIVE);

          for (const message of messages) {
            await queue.add(
              'process-message',
              {
                orgId: org.id,
                phoneNumberId,
                message,
                contacts: contacts || [],
              },
              {
                attempts: 3,
                backoff: {
                  type: 'exponential',
                  delay: 2000,
                },
              }
            );

            logger.info(`Message queued for processing`, {
              orgId: org.id,
              messageId: message.id,
              from: message.from,
              type: message.type,
            });
          }
        }

        // 5. Process status updates
        if (statuses && statuses.length > 0) {
          const queue = getQueue(QUEUE_NAMES.WHATSAPP_RECEIVE);

          for (const status of statuses) {
            await queue.add(
              'process-status',
              {
                orgId: org.id,
                status,
              },
              {
                attempts: 3,
              }
            );

            logger.debug(`Status update queued`, {
              orgId: org.id,
              messageId: status.id,
              status: status.status,
            });
          }
        }
      }
    }

    // 6. Always return 200 immediately - WhatsApp retries if not 200
    res.sendStatus(200);
  })
);

/**
 * GET /webhook/whatsapp
 * Webhook verification endpoint for Meta
 * NOTE: This is already in server.ts but keeping here for reference
 * Meta calls this when you set up the webhook URL
 */
router.get(
  '/whatsapp',
  (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

    if (mode === 'subscribe' && token === verifyToken) {
      logger.info('WhatsApp webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      logger.warn('WhatsApp webhook verification failed', { mode, token });
      res.sendStatus(403);
    }
  }
);

/**
 * POST /webhook/test
 * Test endpoint for development - simulates WhatsApp message
 */
router.post(
  '/test',
  asyncHandler(async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === 'production') {
      return res.status(404).json({ error: 'Not found' });
    }

    const { orgId, from, text } = req.body;

    if (!orgId ||!from ||!text) {
      throw new BadRequestError('orgId, from, and text required');
    }

    // Simulate WhatsApp message payload
    const mockPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'test_business_account',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '1234567890',
                  phone_number_id: 'test_phone_id',
                },
                messages: [
                  {
                    from,
                    id: `test_${Date.now()}`,
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    text: { body: text },
                    type: 'text',
                  },
                ],
                contacts: [
                  {
                    profile: { name: 'Test User' },
                    wa_id: from,
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    // Queue it
    const queue = getQueue(QUEUE_NAMES.WHATSAPP_RECEIVE);
    await queue.add('process-message', {
      orgId,
      phoneNumberId: 'test_phone_id',
      message: mockPayload.entry[0].changes[0].value.messages[0],
      contacts: mockPayload.entry[0].changes[0].value.contacts,
    });

    logger.info('Test webhook queued', { orgId, from, text });

    res.json({
      success: true,
      message: 'Test message queued for processing',
      data: { orgId, from, text },
    });
  })
);

export default router;