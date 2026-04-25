/**
 * Base Application Error Class
 * All custom errors extend this class
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly code?: string;
  public readonly details?: any;

  constructor(
    message: string,
    statusCode: number = 500,
    isOperational: boolean = true,
    code?: string,
    details?: any
  ) {
    super(message);
    
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.code = code;
    this.details = details;

    // Maintains proper stack trace for where error was thrown
    Error.captureStackTrace(this, this.constructor);
    
    // Set the prototype explicitly
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * 400 Bad Request
 * Client sent invalid data
 */
export class BadRequestError extends AppError {
  constructor(message: string = 'Bad Request', details?: any) {
    super(message, 400, true, 'BAD_REQUEST', details);
  }
}

/**
 * 401 Unauthorized
 * Authentication required or failed
 */
export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized', details?: any) {
    super(message, 401, true, 'UNAUTHORIZED', details);
  }
}

/**
 * 403 Forbidden
 * Authenticated but not authorized
 */
export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden', details?: any) {
    super(message, 403, true, 'FORBIDDEN', details);
  }
}

/**
 * 404 Not Found
 * Resource doesn't exist
 */
export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found', details?: any) {
    super(message, 404, true, 'NOT_FOUND', details);
  }
}

/**
 * 409 Conflict
 * Resource conflict (duplicate entry)
 */
export class ConflictError extends AppError {
  constructor(message: string = 'Resource conflict', details?: any) {
    super(message, 409, true, 'CONFLICT', details);
  }
}

/**
 * 422 Unprocessable Entity
 * Validation failed
 */
export class ValidationError extends AppError {
  constructor(message: string = 'Validation failed', details?: any) {
    super(message, 422, true, 'VALIDATION_ERROR', details);
  }
}

/**
 * 429 Too Many Requests
 * Rate limit exceeded
 */
export class TooManyRequestsError extends AppError {
  constructor(message: string = 'Too many requests', details?: any) {
    super(message, 429, true, 'TOO_MANY_REQUESTS', details);
  }
}

/**
 * 500 Internal Server Error
 * Unexpected server error
 */
export class InternalServerError extends AppError {
  constructor(message: string = 'Internal server error', details?: any) {
    super(message, 500, false, 'INTERNAL_SERVER_ERROR', details);
  }
}

/**
 * 503 Service Unavailable
 * External service down (DB, Redis, etc)
 */
export class ServiceUnavailableError extends AppError {
  constructor(message: string = 'Service unavailable', details?: any) {
    super(message, 503, true, 'SERVICE_UNAVAILABLE', details);
  }
}

/**
 * WhatsApp API Error
 * Specific errors from Meta WhatsApp API
 */
export class WhatsAppAPIError extends AppError {
  constructor(message: string, whatsappErrorCode?: number, details?: any) {
    super(
      message,
      502, // Bad Gateway - external API failed
      true,
      'WHATSAPP_API_ERROR',
      { whatsappErrorCode, ...details }
    );
  }
}

/**
 * Stripe Payment Error
 * Specific errors from Stripe
 */
export class StripeError extends AppError {
  constructor(message: string, stripeErrorCode?: string, details?: any) {
    super(
      message,
      402, // Payment Required
      true,
      'STRIPE_ERROR',
      { stripeErrorCode, ...details }
    );
  }
}

/**
 * Database Error
 * Prisma/Database specific errors
 */
export class DatabaseError extends AppError {
  constructor(message: string = 'Database operation failed', details?: any) {
    super(message, 500, false, 'DATABASE_ERROR', details);
  }
}

/**
 * Type guard to check if error is AppError
 */
export const isAppError = (error: any): error is AppError => {
  return error instanceof AppError && error.isOperational === true;
};

/**
 * Convert unknown error to AppError
 */
export const toAppError = (error: unknown): AppError => {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    return new InternalServerError(error.message, { originalError: error.name });
  }

  return new InternalServerError('An unknown error occurred', { error });
};