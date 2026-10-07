import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 login requests per window
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: {
    success: false,
    message: 'Too many login attempts from this IP, please try again after 15 minutes',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

export const aiAssistantLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 AI copilot requests per minute per user/IP
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req: any) => {
    return req.user?._id?.toString() || ipKeyGenerator(req.ip || '127.0.0.1');
  },
  message: {
    success: false,
    message: 'AI Evaluation Assistant rate limit reached. Please wait a moment before requesting further AI suggestions.',
    code: 'AI_RATE_LIMIT_EXCEEDED',
  },
});

