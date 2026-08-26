import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { logger } from '../utils/logger';
import type { ApiErrorBody } from '../types';

/** Error carrying the contract's {status, error_code, message} envelope. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function notFoundHandler(_req: Request, res: Response): void {
  const body: ApiErrorBody = {
    status: 'error',
    error_code: 'NOT_FOUND',
    message: 'Endpoint not found.',
  };
  res.status(404).json(body);
}

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof ApiError) {
    // 4xx is client-driven and expected; do not log it as a server fault.
    if (error.statusCode >= 500) logger.error(error.message, error);
    res.status(error.statusCode).json({
      status: 'error',
      error_code: error.errorCode,
      message: error.message,
    } satisfies ApiErrorBody);
    return;
  }

  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? 'One or more images exceed the maximum allowed size.'
        : error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE'
          ? 'Too many images uploaded. Maximum is 8 files under the "images" field.'
          : `Upload rejected: ${error.message}`;
    res.status(400).json({
      status: 'error',
      error_code: 'INVALID_IMAGE_PAYLOAD',
      message,
    } satisfies ApiErrorBody);
    return;
  }

  logger.error('Unhandled server error', error);
  res.status(500).json({
    status: 'error',
    error_code: 'INTERNAL_ERROR',
    message: 'An unexpected server error occurred.',
  } satisfies ApiErrorBody);
}
