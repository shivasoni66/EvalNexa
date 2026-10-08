import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User, IUser } from '../models/User';
import { config } from '../config';
import { logAuditAction } from './audit.service';

const DEFAULT_SEED_USERS = [
  {
    _id: '665000000000000000000001',
    name: process.env.ADMIN_NAME || 'System Administrator',
    email: (process.env.ADMIN_EMAIL || 'admin@evalnexa.edu').toLowerCase(),
    password: process.env.ADMIN_PASSWORD || 'Admin@1234',
    role: 'ADMIN',
    isActive: true,
  },
  {
    _id: '665000000000000000000002',
    name: process.env.EXAMINER_NAME || 'Dr. Sarah Mitchell',
    email: (process.env.EXAMINER_EMAIL || 'examiner@evalnexa.edu').toLowerCase(),
    password: process.env.EXAMINER_PASSWORD || 'Examiner@5678',
    role: 'EXAMINER',
    isActive: true,
  },
  {
    _id: '665000000000000000000003',
    name: process.env.MODERATOR_NAME || 'Prof. James Harlow',
    email: (process.env.MODERATOR_EMAIL || 'moderator@evalnexa.edu').toLowerCase(),
    password: process.env.MODERATOR_PASSWORD || 'Moderator@9012',
    role: 'MODERATOR',
    isActive: true,
  },
];

export interface LoginResult {
  token: string;
  user: {
    _id: string;
    name: string;
    email: string;
    role: string;
    institutionId?: string;
    isActive: boolean;
  };
}

export async function authenticateUser(email: string, password: string): Promise<LoginResult> {
  const normEmail = email.toLowerCase().trim();

  // If MongoDB is offline, authenticate with default seed credentials from environment
  if (mongoose.connection.readyState !== 1) {
    const defaultUser = DEFAULT_SEED_USERS.find((u) => u.email === normEmail);
    if (!defaultUser || defaultUser.password !== password) {
      const error: any = new Error('Invalid credentials');
      error.status = 401;
      error.code = 'INVALID_CREDENTIALS';
      throw error;
    }

    const token = jwt.sign(
      { userId: defaultUser._id, role: defaultUser.role },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'] }
    );

    return {
      token,
      user: {
        _id: defaultUser._id,
        name: defaultUser.name,
        email: defaultUser.email,
        role: defaultUser.role,
        isActive: true,
      },
    };
  }

  const user = await User.findOne({ email: normEmail }).select('+passwordHash');
  if (!user) {
    const error: any = new Error('Invalid credentials');
    error.status = 401;
    error.code = 'INVALID_CREDENTIALS';
    throw error;
  }

  if (!user.isActive) {
    const error: any = new Error('Account is deactivated');
    error.status = 403;
    error.code = 'ACCOUNT_DEACTIVATED';
    throw error;
  }

  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) {
    const error: any = new Error('Invalid credentials');
    error.status = 401;
    error.code = 'INVALID_CREDENTIALS';
    throw error;
  }

  const token = jwt.sign(
    { userId: user._id.toString(), role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'] }
  );

  await logAuditAction({
    actorId: user._id.toString(),
    action: 'USER_LOGIN',
    entityType: 'User',
    entityId: user._id.toString(),
    metadata: { email: user.email },
  });

  return {
    token,
    user: {
      _id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
      institutionId: user.institutionId,
      isActive: user.isActive,
    },
  };
}

export async function getUserProfile(userId: string): Promise<IUser | null> {
  if (mongoose.connection.readyState !== 1) {
    const defaultUser = DEFAULT_SEED_USERS.find((u) => u._id === userId);
    if (defaultUser) {
      return defaultUser as any;
    }
  }
  return User.findById(userId);
}
