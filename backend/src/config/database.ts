import mongoose from 'mongoose';
import { config } from './index';

export async function connectDatabase(): Promise<void> {
  if (!config.mongoUri) {
    throw new Error('MONGODB_URI is not defined. Please set it in your .env file.');
  }

  try {
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 3000 });
    console.log('[DB] MongoDB connected successfully');
  } catch (error) {
    console.warn(`[DB] Could not connect to MongoDB at ${config.mongoUri}. Continuing in offline fallback mode.`);
  }
}

mongoose.connection.on('disconnected', () => {
  console.warn('[DB] MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
  console.log('[DB] MongoDB reconnected');
});
