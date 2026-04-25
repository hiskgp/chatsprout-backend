import OpenAI from 'openai';
import { prisma } from '../utils/prisma';
import { cache } from './redis.service';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errors';

interface AIConfig {
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

interface ConversationContext {
  conversationId: string;
  orgId: string;
  contactId: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
  }>;
}

interface RAGDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, any>;
}

/**
 * AI Service
 * Handles OpenAI integration, RAG, embeddings, auto-replies
 */
export class AIService {
  private openai: OpenAI;
  private config: AIConfig;

  constructor(config: AIConfig) {
    this.config = config;
    this.openai = new OpenAI({
      apiKey: config.apiKey,
    });
  }

  /**
   * Generate embedding for text
   * Used for RAG - semantic search
   */
  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
        encoding_format: 'float',
      });

      return response.data[0].embedding;
    } catch (error: any) {
      logger.error('Failed to generate embedding:', error);
      throw new AppError('AI embedding failed', 500, false, 'AI_EMBEDDING_ERROR');
    }
  }

  /**
   * Search knowledge base using RAG
   * Finds relevant docs using cosine similarity
   */
  async searchKnowledgeBase(
    orgId: string,
    query: string,
    limit: number = 3
  ): Promise<RAGDocument[]> {
    try {
      // 1. Generate embedding for query
      const queryEmbedding = await this.generateEmbedding(query);

      // 2. Check cache first
      const cacheKey = `rag:${orgId}:${Buffer.from(query).toString('base64').slice(0, 32)}`;
      const cached = await cache.get<RAGDocument[]>(cacheKey);
      if (cached) {
        logger.debug('RAG cache hit');
        return cached;
      }

      // 3. Get all org documents with embeddings
      const documents = await prisma.knowledgeBase.findMany({
        where: {
          orgId,
          status: 'ACTIVE',
        },
        select: {
          id: true,
          content: true,
          embedding: true,
          metadata: true,
        },
      });

      if (documents.length === 0) {
        return [];
      }

      // 4. Calculate cosine similarity
      const scored = documents
       .map((doc) => {
          const embedding = doc.embedding as number[];
          const similarity = this.cosineSimilarity(queryEmbedding, embedding);
          return {
            id: doc.id,
            content: doc.content,
            embedding,
            metadata: doc.metadata as Record<string, any>,
            score: similarity,
          };
        })
       .sort((a, b) => b.score - a.score)
       .slice(0, limit)
       .filter((doc) => doc.score > 0.7); // Minimum similarity threshold

      // 5. Cache for 5 minutes
      await cache.set(cacheKey, scored, 300);

      return scored;
    } catch (error) {
      logger.error('RAG search failed:', error);
      return [];
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length!== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Generate AI reply using GPT-4 + RAG context
   */
  async generateReply(context: ConversationContext): Promise<string> {
    try {
      // 1. Get last user message
      const lastUserMessage = context.messages
       .filter((m) => m.role === 'user')
       .pop();

      if (!lastUserMessage) {
        throw new AppError('No user message found', 400);
      }

      // 2. Search knowledge base for relevant context
      const ragDocs = await this.searchKnowledgeBase(
        context.orgId,
        lastUserMessage.content,
        3
      );

      // 3. Get org AI settings
      const org = await prisma.organization.findUnique({
        where: { id: context.orgId },
        select: {
          aiBotName: true,
          aiPersonality: true,
          aiInstructions: true,
          aiModel: true,
        },
      });

      // 4. Build system prompt with RAG context
      let systemPrompt = `You are ${org?.aiBotName || 'Wexo AI'}, a helpful WhatsApp business assistant.

${org?.aiPersonality || 'You are professional, friendly, and concise.'}

${org?.aiInstructions || 'Help customers with their queries. If you don\'t know, ask for clarification.'}

Important rules:
- Keep replies short and conversational (1-3 sentences max)
- Use emojis sparingly and naturally
- If customer asks about pricing/orders, guide them to browse catalog
- Never make up information not in your knowledge base
- If unsure, say "Let me check that for you" and escalate to human agent
`;

      // Add RAG context if available
      if (ragDocs.length > 0) {
        systemPrompt += `\n\nRelevant knowledge base:\n`;
        ragDocs.forEach((doc, i) => {
          systemPrompt += `${i + 1}. ${doc.content}\n`;
        });
      }

      // 5. Build message history (last 10 messages for context)
      const messageHistory = context.messages.slice(-10).map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      // 6. Call OpenAI
      const completion = await this.openai.chat.completions.create({
        model: org?.aiModel || this.config.model || 'gpt-4-turbo-preview',
        messages: [
          { role: 'system', content: systemPrompt },
         ...messageHistory,
        ],
        temperature: this.config.temperature || 0.7,
        max_tokens: this.config.maxTokens || 150,
        presence_penalty: 0.6,
        frequency_penalty: 0.3,
      });

      const reply = completion.choices[0]?.message?.content?.trim();

      if (!reply) {
        throw new AppError('AI generated empty response', 500);
      }

      logger.info(`AI reply generated for ${context.conversationId}`, {
        tokens: completion.usage?.total_tokens,
        ragDocsUsed: ragDocs.length,
      });

      return reply;
    } catch (error: any) {
      logger.error('AI reply generation failed:', error);

      if (error.code === 'insufficient_quota') {
        throw new AppError('AI quota exceeded', 503, true, 'AI_QUOTA_EXCEEDED');
      }

      if (error.code === 'rate_limit_exceeded') {
        throw new AppError('AI rate limit hit', 429, true, 'AI_RATE_LIMIT');
      }

      throw new AppError('AI reply generation failed', 500, false, 'AI_ERROR');
    }
  }

  /**
   * Summarize conversation
   * Used for handoff to human agent
   */
  async summarizeConversation(context: ConversationContext): Promise<string> {
    try {
      const messages = context.messages
       .map((m) => `${m.role === 'user'? 'Customer' : 'Bot'}: ${m.content}`)
       .join('\n');

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4-turbo-preview',
        messages: [
          {
            role: 'system',
            content:
              'Summarize this customer conversation in 2-3 bullet points. Focus on: 1) Customer intent 2) What was resolved 3) What needs human attention',
          },
          {
            role: 'user',
            content: messages,
          },
        ],
        temperature: 0.3,
        max_tokens: 200,
      });

      return completion.choices[0]?.message?.content?.trim() || 'Unable to summarize';
    } catch (error) {
      logger.error('Conversation summarization failed:', error);
      return 'Conversation summary unavailable';
    }
  }

  /**
   * Detect customer intent
   * Returns: 'order' | 'support' | 'info' | 'complaint' | 'other'
   */
  async detectIntent(message: string): Promise<string> {
    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4-turbo-preview',
        messages: [
          {
            role: 'system',
            content:
              'Classify customer message intent. Reply with ONLY one word: order, support, info, complaint, or other',
          },
          {
            role: 'user',
            content: message,
          },
        ],
        temperature: 0.1,
        max_tokens: 10,
      });

      const intent = completion.choices[0]?.message?.content?.trim().toLowerCase();
      return ['order', 'support', 'info', 'complaint'].includes(intent || '')? intent! : 'other';
    } catch (error) {
      logger.error('Intent detection failed:', error);
      return 'other';
    }
  }

  /**
   * Extract entities from message
   * Returns: { products: [], orderId: string, email: string }
   */
  async extractEntities(message: string): Promise<Record<string, any>> {
    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4-turbo-preview',
        messages: [
          {
            role: 'system',
            content:
              'Extract entities from customer message. Return JSON with: products (array), orderId (string), email (string), phone (string). Use null if not found.',
          },
          {
            role: 'user',
            content: message,
          },
        ],
        temperature: 0.1,
        max_tokens: 150,
        response_format: { type: 'json_object' },
      });

      const content = completion.choices[0]?.message?.content;
      return content? JSON.parse(content) : {};
    } catch (error) {
      logger.error('Entity extraction failed:', error);
      return {};
    }
  }

  /**
   * Check if message needs human handoff
   */
  async shouldHandoffToHuman(context: ConversationContext): Promise<boolean> {
    const lastMessage = context.messages[context.messages.length - 1]?.content || '';

    // Keywords that trigger handoff
    const handoffKeywords = [
      'speak to human',
      'talk to agent',
      'real person',
      'manager',
      'complaint',
      'refund',
      'cancel order',
      'not working',
      'frustrated',
    ];

    const lowerMessage = lastMessage.toLowerCase();
    if (handoffKeywords.some((kw) => lowerMessage.includes(kw))) {
      return true;
    }

    // Check if AI failed multiple times
    const recentBotMessages = context.messages
     .slice(-4)
     .filter((m) => m.role === 'assistant');

    if (recentBotMessages.length >= 2) {
      const hasUncertainty = recentBotMessages.some((m) =>
        m.content.toLowerCase().includes("i'm not sure") ||
        m.content.toLowerCase().includes("i don't know") ||
        m.content.toLowerCase().includes('let me check')
      );
      if (hasUncertainty) return true;
    }

    return false;
  }
}

/**
 * Factory function to create AI service instance
 * Gets config from org settings
 */
export const createAIService = async (orgId: string): Promise<AIService> => {
  // Check cache
  const cacheKey = `ai:config:${orgId}`;
  let config = await cache.get<AIConfig>(cacheKey);

  if (!config) {
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: {
        aiApiKey: true,
        aiModel: true,
        aiTemperature: true,
        aiMaxTokens: true,
      },
    });

    if (!org?.aiApiKey) {
      throw new AppError('AI not configured for this organization', 400, true, 'AI_NOT_CONFIGURED');
    }

    config = {
      apiKey: org.aiApiKey,
      model: org.aiModel || 'gpt-4-turbo-preview',
      temperature: org.aiTemperature || 0.7,
      maxTokens: org.aiMaxTokens || 150,
    };

    // Cache for 1 hour
    await cache.set(cacheKey, config, 3600);
  }

  return new AIService(config);
};

export default AIService;