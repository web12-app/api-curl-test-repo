'use strict';

// An error that is safe to show to the client: a status, a stable code, and a plain message.
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    // Optional, safe to show: for example the list of missing chunk numbers.
    if (details !== undefined) this.details = details;
  }
}

// The data changed since it was read (stale SHA). The caller must re-read; writes are never retried.
class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
  }
}

// The private data store is unavailable or returned an unexpected response.
class StorageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageError';
  }
}

module.exports = { AppError, ConflictError, StorageError };
