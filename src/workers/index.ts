import { Worker, Job } from 'bullmq';
import { getRedisClient, QUEUE_NAMES, getQueue } from '../services/redis.service';
import { WhatsAppService, createWhatsAppService } from '../services/whatsapp.service';
import { AIService, createAIService } from '../services/ai.service';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import { io } from '../server';

const redisConnection = getRedisClient();

/**
 * WhatsApp Send Worker
 */
const whatsappSendWorker = new Worker(
  QUEUE_NAMES.WHATSAPP_SEND, // Now: 'whatsapp-send'
  async (job: Job) => {
    const { orgId, phoneNumberId, payload } = job.data;

    try {
      logger.info(`Processing WhatsApp send job: ${job.id}`, { orgId, to: payload.to });

      const whatsappService = await createWhatsAppService(orgId);
      let result;

      switch (payload.type) {
        case 'text':
          result = await whatsappService.sendTextMessage(
            payload.to,
            payload.text.body,
            payload.text.preview_url
          );
          break;

        case 'image':
          result = await whatsappService.sendImageMessage(
            payload.to,
            payload.image.link,
            payload.image.caption
          );
          break;

        case 'document':
          result = await whatsappService.sendDocumentMessage(
            payload.to,
            payload.document.link,
            payload.document.filename,
            payload.document.caption
          );
          break;

        case 'template':
          result = await whatsappService.sendTemplateMessage(
            payload.to,
            payload.template.name,
            payload.template.language.code,
            payload.template.components
          );
          break;

        case 'interactive':
          if (payload.interactive.type === 'button') {
            result = await whatsappService.sendButtonMessage(
              payload.to,
              payload.interactive.body.text,
              payload.interactive.action.buttons.map((b: any) => ({
                id: b.reply.id,
                title: b.reply.title,
              })),
              payload.interactive.header?.text,
              payload.interactive.footer?.text
            );
          } else if (payload.interactive.type === 'list') {
            result = await whatsappService.sendListMessage(
              payload.to,
              payload.interactive.body.text,
              payload.interactive.action.button,
              payload.interactive.action.sections,
              payload.interactive.header?.text,
              payload.interactive.footer?.text
            );
          }
          break;

        default:
          throw new Error(`Unsupported message type: ${payload.type}`);
      }

      const messageId = result.messages[0].id;
      await prisma.message.create({
        data: {
          whatsappId: messageId,
          orgId,
          direction: 'OUTBOUND',
          type: payload.type.toUpperCase(),
          content: JSON.stringify(payload),
          status: 'SENT',
          sentAt: new Date(),
        },
      });

      io.to(`org:${orgId}`).emit('message:sent', {
        messageId,
        to: payload.to,
        type: payload.type,
      });

      logger.info(`WhatsApp message sent successfully: ${messageId}`);
      return { success: true, messageId };
    } catch (error: any) {
      logger.error(`WhatsApp send failed for job ${job.id}:`, error);

      await prisma.message.updateMany({
        where: { whatsappId: job.id },
        data: { status: 'FAILED', error: error.message },
      });

      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: 10,
    limiter: {
      max: 80,
      duration: 1000,
    },
  }
);

/**
 * WhatsApp Receive Worker
 */
const whatsappReceiveWorker = new Worker(
  QUEUE_NAMES.WHATSAPP_RECEIVE, // Now: 'whatsapp-receive'
  async (job: Job) => {
    const { orgId, message } = job.data;

    try {
      logger.info(`Processing incoming WhatsApp message: ${message.id}`, { orgId });

      const phoneNumber = message.from;
      let contact = await prisma.contact.findFirst({
        where: { orgId, phoneNumber },
      });

      if (!contact) {
        contact = await prisma.contact.create({
          data: {
            orgId,
            phoneNumber,
            name: phoneNumber,
            source: 'WHATSAPP',
          },
        });
        logger.info(`New contact created: ${contact.id}`);
      }

      let conversation = await prisma.conversation.findFirst({
        where: {
          orgId,
          contactId: contact.id,
          status: { in: ['OPEN', 'PENDING'] },
        },
      });

      if (!conversation) {
        conversation = await prisma.conversation.create({
          data: {
            orgId,
            contactId: contact.id,
            status: 'OPEN',
            channel: 'WHATSAPP',
          },
        });
        logger.info(`New conversation created: ${conversation.id}`);
      }

      const savedMessage = await prisma.message.create({
        data: {
          whatsappId: message.id,
          orgId,
          conversationId: conversation.id,
          contactId: contact.id,
          direction: 'INBOUND',
          type: message.type.toUpperCase(),
          content: JSON.stringify(message),
          status: 'DELIVERED',
          receivedAt: new Date(parseInt(message.timestamp) * 1000),
        },
      });

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: new Date(),
          unreadCount: { increment: 1 },
        },
      });

      io.to(`org:${orgId}`).emit('message:received', {
        conversationId: conversation.id,
        message: savedMessage,
      });

      io.to(`conversation:${conversation.id}`).emit('message:new', savedMessage);

      const whatsappService = await createWhatsAppService(orgId);
      await whatsappService.markAsRead(message.id);

      // ✅ FIXED: prisma.org instead of prisma.organization
      const org = await prisma.org.findUnique({
        where: { id: orgId },
        select: { aiEnabled: true, aiAutoReply: true },
      });

      if (org?.aiEnabled && org?.aiAutoReply && conversation.status === 'OPEN') {
        const aiQueue = getQueue(QUEUE_NAMES.AI_PROCESS);
        await aiQueue.add('generate-reply', {
          orgId,
          conversationId: conversation.id,
          contactId: contact.id,
          messageId: savedMessage.id,
        });
        logger.info(`AI reply queued for conversation: ${conversation.id}`);
      }

      return { success: true, conversationId: conversation.id };
    } catch (error: any) {
      logger.error(`WhatsApp receive failed for job ${job.id}:`, error);
      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: 20,
  }
);

/**
 * AI Process Worker
 */
const aiProcessWorker = new Worker(
  QUEUE_NAMES.AI_PROCESS, // Now: 'ai-process'
  async (job: Job) => {
    const { orgId, conversationId, contactId, messageId } = job.data;

    try {
      logger.info(`Processing AI reply job: ${job.id}`, { conversationId });

      const messages = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          direction: true,
          content: true,
          createdAt: true,
        },
      });

      const context = {
        conversationId,
        orgId,
        contactId,
        messages: messages.reverse().map((m) => ({
          role: m.direction === 'INBOUND'? 'user' : 'assistant',
          content: JSON.parse(m.content).text?.body || JSON.stringify(m.content),
          timestamp: m.createdAt,
        })),
      };

      const aiService = await createAIService(orgId);
      const shouldHandoff = await aiService.shouldHandoffToHuman(context);

      if (shouldHandoff) {
        await prisma.conversation.update({
          where: { id: conversationId },
          data: { status: 'PENDING', assignedToId: null },
        });

        io.to(`org:${orgId}`).emit('conversation:handoff', {
          conversationId,
          reason: 'AI_DETECTED_HANDOFF',
        });

        logger.info(`Conversation handed off to human: ${conversationId}`);
        return { success: true, handoff: true };
      }

      const reply = await aiService.generateReply(context);

      const contact = await prisma.contact.findUnique({
        where: { id: contactId },
        select: { phoneNumber: true },
      });

      if (!contact) {
        throw new Error('Contact not found');
      }

      const whatsappQueue = getQueue(QUEUE_NAMES.WHATSAPP_SEND);
      await whatsappQueue.add('send-message', {
        orgId,
        payload: {
          to: contact.phoneNumber,
          type: 'text',
          text: { body: reply },
        },
      });

      logger.info(`AI reply sent for conversation: ${conversationId}`);
      return { success: true, reply };
    } catch (error: any) {
      logger.error(`AI process failed for job ${job.id}:`, error);

      await prisma.conversation.update({
        where: { id: conversationId },
        data: { status: 'PENDING' },
      });

      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: 5,
  }
);

/**
 * Campaign Send Worker
 */
const campaignSendWorker = new Worker(
  QUEUE_NAMES.CAMPAIGN_SEND, // Now: 'campaign-send'
  async (job: Job) => {
    const { orgId, campaignId, contactIds } = job.data;

    try {
      logger.info(`Processing campaign send job: ${job.id}`, { campaignId, count: contactIds.length });

      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        include: { template: true },
      });

      if (!campaign || campaign.status!== 'SCHEDULED') {
        throw new Error('Campaign not found or not scheduled');
      }

      const whatsappService = await createWhatsAppService(orgId);
      const whatsappQueue = getQueue(QUEUE_NAMES.WHATSAPP_SEND);

      let sent = 0;
      let failed = 0;

      for (const contactId of contactIds) {
        try {
          const contact = await prisma.contact.findUnique({
            where: { id: contactId },
            select: { phoneNumber: true, name: true },
          });

          if (!contact) continue;

          const components = campaign.template.components?.map((comp: any) => {
            if (comp.type === 'body') {
              return {
               ...comp,
                parameters: comp.parameters?.map((p: any) => ({
                 ...p,
                  text: p.text.replace('{{name}}', contact.name || 'there'),
                })),
              };
            }
            return comp;
          });

          await whatsappQueue.add('send-message', {
            orgId,
            payload: {
              to: contact.phoneNumber,
              type: 'template',
              template: {
                name: campaign.template.name,
                language: { code: campaign.template.language },
                components,
              },
            },
          });

          sent++;
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch (error) {
          logger.error(`Failed to send campaign to contact ${contactId}:`, error);
          failed++;
        }
      }

      await prisma.campaign.update({
        where: { id: campaignId },
        data: {
          status: 'COMPLETED',
          sentCount: sent,
          failedCount: failed,
          completedAt: new Date(),
        },
      });

      logger.info(`Campaign completed: ${campaignId}`, { sent, failed });
      return { success: true, sent, failed };
    } catch (error: any) {
      logger.error(`Campaign send failed for job ${job.id}:`, error);
      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: 2,
  }
);

/**
 * Worker event handlers
 */
const setupWorkerEvents = (worker: Worker, name: string) => {
  worker.on('completed', (job) => {
    logger.info(`Worker ${name} completed job ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Worker ${name} failed job ${job?.id}:`, err);
  });

  worker.on('error', (err) => {
    logger.error(`Worker ${name} error:`, err);
  });
};

setupWorkerEvents(whatsappSendWorker, 'WhatsAppSend');
setupWorkerEvents(whatsappReceiveWorker, 'WhatsAppReceive');
setupWorkerEvents(aiProcessWorker, 'AIProcess');
setupWorkerEvents(campaignSendWorker, 'CampaignSend');

/**
 * Graceful shutdown
 */
export const closeWorkers = async (): Promise<void> => {
  await Promise.all([
    whatsappSendWorker.close(),
    whatsappReceiveWorker.close(),
    aiProcessWorker.close(),
    campaignSendWorker.close(),
  ]);
  logger.info('All workers closed');
};

logger.info('🚀 All workers initialized and running');