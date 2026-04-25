import axios, { AxiosInstance } from 'axios';
import { getQueue, QUEUE_NAMES, cache } from './redis.service';
import { logger } from '../utils/logger';
import { WhatsAppAPIError } from '../utils/errors';
import { prisma } from '../utils/prisma';

interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  apiVersion: string;
}

interface SendMessagePayload {
  to: string;
  type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'template' | 'interactive';
  text?: { body: string; preview_url?: boolean };
  image?: { link: string; caption?: string };
  document?: { link: string; filename?: string; caption?: string };
  audio?: { link: string };
  video?: { link: string; caption?: string };
  template?: {
    name: string;
    language: { code: string };
    components?: any[];
  };
  interactive?: {
    type: 'button' | 'list';
    header?: { type: 'text'; text: string };
    body: { text: string };
    footer?: { text: string };
    action: any;
  };
}

interface WhatsAppMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; sha256: string; caption?: string };
  document?: { id: string; mime_type: string; sha256: string; filename?: string };
  audio?: { id: string; mime_type: string; sha256: string; voice?: boolean };
  video?: { id: string; mime_type: string; sha256: string };
  button?: { payload: string; text: string };
  interactive?: { type: string; button_reply?: any; list_reply?: any };
}

/**
 * WhatsApp Service
 * Handles all WhatsApp Cloud API operations
 */
export class WhatsAppService {
  private apiClient: AxiosInstance;
  private config: WhatsAppConfig;

  constructor(config: WhatsAppConfig) {
    this.config = config;
    this.apiClient = axios.create({
      baseURL: `https://graph.facebook.com/${config.apiVersion}`,
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }

  /**
   * Send message to WhatsApp
   * Queues message for async sending with rate limiting
   */
  async sendMessage(orgId: string, payload: SendMessagePayload): Promise<string> {
    const queue = getQueue(QUEUE_NAMES.WHATSAPP_SEND);

    const job = await queue.add(
      'send-message',
      {
        orgId,
        phoneNumberId: this.config.phoneNumberId,
        payload,
      },
      {
        priority: payload.type === 'text'? 1 : 2, // Text messages higher priority
      }
    );

    logger.info(`WhatsApp message queued: ${job.id}`, { orgId, to: payload.to });
    return job.id!;
  }

  /**
   * Send text message immediately
   * Used by workers
   */
  async sendTextMessage(to: string, text: string, previewUrl: boolean = false): Promise<any> {
    try {
      const response = await this.apiClient.post(
        `/${this.config.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: {
            body: text,
            preview_url: previewUrl,
          },
        }
      );

      logger.info(`WhatsApp text sent to ${to}`, { messageId: response.data.messages[0].id });
      return response.data;
    } catch (error: any) {
      this.handleWhatsAppError(error, 'sendTextMessage');
    }
  }

  /**
   * Send image message
   */
  async sendImageMessage(to: string, imageUrl: string, caption?: string): Promise<any> {
    try {
      const response = await this.apiClient.post(
        `/${this.config.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'image',
          image: {
            link: imageUrl,
            caption,
          },
        }
      );

      logger.info(`WhatsApp image sent to ${to}`);
      return response.data;
    } catch (error: any) {
      this.handleWhatsAppError(error, 'sendImageMessage');
    }
  }

  /**
   * Send document message
   */
  async sendDocumentMessage(
    to: string,
    documentUrl: string,
    filename?: string,
    caption?: string
  ): Promise<any> {
    try {
      const response = await this.apiClient.post(
        `/${this.config.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'document',
          document: {
            link: documentUrl,
            filename,
            caption,
          },
        }
      );

      logger.info(`WhatsApp document sent to ${to}`);
      return response.data;
    } catch (error: any) {
      this.handleWhatsAppError(error, 'sendDocumentMessage');
    }
  }

  /**
   * Send template message
   * Used for notifications, OTPs, etc
   */
  async sendTemplateMessage(
    to: string,
    templateName: string,
    languageCode: string = 'en',
    components?: any[]
  ): Promise<any> {
    try {
      const response = await this.apiClient.post(
        `/${this.config.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'template',
          template: {
            name: templateName,
            language: { code: languageCode },
            components,
          },
        }
      );

      logger.info(`WhatsApp template sent to ${to}`, { template: templateName });
      return response.data;
    } catch (error: any) {
      this.handleWhatsAppError(error, 'sendTemplateMessage');
    }
  }

  /**
   * Send interactive button message
   */
  async sendButtonMessage(
    to: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>,
    headerText?: string,
    footerText?: string
  ): Promise<any> {
    try {
      const response = await this.apiClient.post(
        `/${this.config.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'interactive',
          interactive: {
            type: 'button',
            header: headerText? { type: 'text', text: headerText } : undefined,
            body: { text: bodyText },
            footer: footerText? { text: footerText } : undefined,
            action: {
              buttons: buttons.map((btn) => ({
                type: 'reply',
                reply: {
                  id: btn.id,
                  title: btn.title,
                },
              })),
            },
          },
        }
      );

      logger.info(`WhatsApp button message sent to ${to}`);
      return response.data;
    } catch (error: any) {
      this.handleWhatsAppError(error, 'sendButtonMessage');
    }
  }

  /**
   * Send interactive list message
   */
  async sendListMessage(
    to: string,
    bodyText: string,
    buttonText: string,
    sections: Array<{
      title: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>,
    headerText?: string,
    footerText?: string
  ): Promise<any> {
    try {
      const response = await this.apiClient.post(
        `/${this.config.phoneNumberId}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'interactive',
          interactive: {
            type: 'list',
            header: headerText? { type: 'text', text: headerText } : undefined,
            body: { text: bodyText },
            footer: footerText? { text: footerText } : undefined,
            action: {
              button: buttonText,
              sections,
            },
          },
        }
      );

      logger.info(`WhatsApp list message sent to ${to}`);
      return response.data;
    } catch (error: any) {
      this.handleWhatsAppError(error, 'sendListMessage');
    }
  }

  /**
   * Mark message as read
   */
  async markAsRead(messageId: string): Promise<void> {
    try {
      await this.apiClient.post(`/${this.config.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      });
    } catch (error: any) {
      logger.error('Failed to mark message as read:', error);
    }
  }

  /**
   * Download media from WhatsApp
   */
  async downloadMedia(mediaId: string): Promise<Buffer> {
    try {
      // 1. Get media URL
      const mediaResponse = await this.apiClient.get(`/${mediaId}`);
      const mediaUrl = mediaResponse.data.url;

      // 2. Download media
      const downloadResponse = await axios.get(mediaUrl, {
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
        },
        responseType: 'arraybuffer',
      });

      return Buffer.from(downloadResponse.data);
    } catch (error: any) {
      this.handleWhatsAppError(error, 'downloadMedia');
    }
  }

  /**
   * Upload media to WhatsApp
   * Returns media ID
   */
  async uploadMedia(file: Buffer, mimeType: string): Promise<string> {
    try {
      const formData = new FormData();
      formData.append('file', new Blob([file]), 'file');
      formData.append('messaging_product', 'whatsapp');
      formData.append('type', mimeType);

      const response = await axios.post(
        `https://graph.facebook.com/${this.config.apiVersion}/${this.config.phoneNumberId}/media`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${this.config.accessToken}`,
            'Content-Type': 'multipart/form-data',
          },
        }
      );

      return response.data.id;
    } catch (error: any) {
      this.handleWhatsAppError(error, 'uploadMedia');
    }
  }

  /**
   * Process incoming webhook
   * Parses WhatsApp webhook payload
   */
  static parseWebhook(body: any): WhatsAppMessage[] {
    const messages: WhatsAppMessage[] = [];

    try {
      const entries = body.entry || [];
      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          const value = change.value;
          if (value.messages) {
            messages.push(...value.messages);
          }
        }
      }
    } catch (error) {
      logger.error('Failed to parse WhatsApp webhook:', error);
    }

    return messages;
  }

  /**
   * Handle WhatsApp API errors
   */
  private handleWhatsAppError(error: any, method: string): never {
    const errorData = error.response?.data?.error;

    if (errorData) {
      logger.error(`WhatsApp API error in ${method}:`, errorData);
      throw new WhatsAppAPIError(
        errorData.message || 'WhatsApp API error',
        errorData.code,
        {
          type: errorData.type,
          fbtrace_id: errorData.fbtrace_id,
        }
      );
    }

    logger.error(`WhatsApp error in ${method}:`, error.message);
    throw new WhatsAppAPIError(error.message || 'WhatsApp operation failed');
  }
}

/**
 * Factory function to create WhatsApp service instance
 * Gets config from database per org
 */
export const createWhatsAppService = async (orgId: string): Promise<WhatsAppService> => {
  // Check cache first
  const cacheKey = `whatsapp:config:${orgId}`;
  let config = await cache.get<WhatsAppConfig>(cacheKey);

  if (!config) {
    // Get from database
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: {
        whatsappPhoneNumberId: true,
        whatsappAccessToken: true,
        whatsappApiVersion: true,
      },
    });

    if (!org ||!org.whatsappPhoneNumberId ||!org.whatsappAccessToken) {
      throw new WhatsAppAPIError('WhatsApp not configured for this organization');
    }

    config = {
      phoneNumberId: org.whatsappPhoneNumberId,
      accessToken: org.whatsappAccessToken,
      apiVersion: org.whatsappApiVersion || 'v18.0',
    };

    // Cache for 1 hour
    await cache.set(cacheKey, config, 3600);
  }

  return new WhatsAppService(config);
};

export default WhatsAppService;