/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * MongoDB service — manages voice_sessions and task_knowledge collections.
 * Uses the native mongodb driver (no Mongoose) to keep the footprint minimal.
 */
import { MongoClient, Db, Collection, ObjectId } from 'mongodb';
import { logger } from '@main/logger';
import { mongoUri } from '@main/env';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Citation {
  title: string;
  url: string;
}

export interface VoiceSession {
  _id?: ObjectId;
  sessionId: string;
  timestamp: Date;
  language: string;
  userTranscript: string;
  aiResponse: string;
  citations: Citation[];
  taskId?: string | null;
}

export type TaskStepStatus = 'pending' | 'in_progress' | 'done' | 'failed';

export interface TaskStep {
  stepNumber: number; // 1–10
  description: string;
  status: TaskStepStatus;
  result?: string | null;
  timestamp?: Date | null;
}

export interface TaskKnowledge {
  _id?: ObjectId;
  taskId: string;
  taskTitle: string;
  totalSteps: number;
  steps: TaskStep[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ActiveAgentState {
  _id?: ObjectId;
  sessionId: string;
  status: string;
  instructions: string;
  lastStepIndex: number;
  lastPredictionText?: string | null;
  lastScreenshotBase64?: string | null;
  updatedAt: Date;
}

// ─── Service ─────────────────────────────────────────────────────────────────

class MongoService {
  private static instance: MongoService;
  private client: MongoClient | null = null;
  private db: Db | null = null;

  private constructor() {}

  public static getInstance(): MongoService {
    if (!MongoService.instance) {
      MongoService.instance = new MongoService();
    }
    return MongoService.instance;
  }

  /** Connect to MongoDB Atlas. Called once at app startup. */
  public async connect(): Promise<void> {
    if (this.client) return; // already connected
    try {
      this.client = new MongoClient(mongoUri, {
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 8000,
        socketTimeoutMS: 30000,
      });
      await this.client.connect();
      this.db = this.client.db('Gemini_DB');

      // Ensure indexes
      await this.voiceSessions().createIndex({ sessionId: 1, timestamp: -1 });
      await this.voiceSessions().createIndex({ timestamp: -1 });
      await this.taskKnowledge().createIndex({ taskId: 1 }, { unique: true });
      await this.activeStates().createIndex({ sessionId: 1 });
      await this.activeStates().createIndex({ updatedAt: -1 });

      logger.info('[MongoService] Connected to MongoDB Atlas');
    } catch (err) {
      logger.error('[MongoService] Failed to connect:', err);
      // Non-fatal: the app still works without MongoDB (voice history won't persist)
      this.client = null;
      this.db = null;
    }
  }

  public async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      logger.info('[MongoService] Disconnected from MongoDB');
    }
  }

  private voiceSessions(): Collection<VoiceSession> {
    if (!this.db) throw new Error('MongoDB not connected');
    return this.db.collection<VoiceSession>('voice_sessions');
  }

  private taskKnowledge(): Collection<TaskKnowledge> {
    if (!this.db) throw new Error('MongoDB not connected');
    return this.db.collection<TaskKnowledge>('task_knowledge');
  }

  private activeStates(): Collection<ActiveAgentState> {
    if (!this.db) throw new Error('MongoDB not connected');
    return this.db.collection<ActiveAgentState>('active_agent_states');
  }

  public isConnected(): boolean {
    return this.db !== null;
  }

  // ─── Voice Sessions ──────────────────────────────────────────────────────

  public async saveVoiceTurn(data: Omit<VoiceSession, '_id'>): Promise<void> {
    try {
      await this.voiceSessions().insertOne({
        ...data,
        timestamp: new Date(),
      });
    } catch (err) {
      logger.warn('[MongoService] saveVoiceTurn failed (non-fatal):', err);
    }
  }

  public async getRecentHistory(limit = 20): Promise<VoiceSession[]> {
    try {
      return await this.voiceSessions()
        .find({})
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
    } catch (err) {
      logger.warn('[MongoService] getRecentHistory failed:', err);
      return [];
    }
  }

  // ─── Task Knowledge Base ─────────────────────────────────────────────────

  /** Create or fully replace a task's 10-step knowledge base */
  public async upsertTaskKnowledge(data: Omit<TaskKnowledge, '_id' | 'createdAt' | 'updatedAt'>): Promise<void> {
    try {
      const now = new Date();
      await this.taskKnowledge().updateOne(
        { taskId: data.taskId },
        {
          $set: { ...data, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
    } catch (err) {
      logger.warn('[MongoService] upsertTaskKnowledge failed:', err);
    }
  }

  /** Update a single step in an existing task knowledge doc */
  public async updateTaskStep(
    taskId: string,
    stepNumber: number,
    update: Partial<TaskStep>,
  ): Promise<void> {
    try {
      await this.taskKnowledge().updateOne(
        { taskId, 'steps.stepNumber': stepNumber },
        {
          $set: {
            [`steps.$.status`]: update.status,
            [`steps.$.result`]: update.result ?? null,
            [`steps.$.timestamp`]: update.timestamp ?? new Date(),
            updatedAt: new Date(),
          },
        },
      );
    } catch (err) {
      logger.warn('[MongoService] updateTaskStep failed:', err);
    }
  }

  public async getTaskKnowledge(taskId: string): Promise<TaskKnowledge | null> {
    try {
      return await this.taskKnowledge().findOne({ taskId });
    } catch (err) {
      logger.warn('[MongoService] getTaskKnowledge failed:', err);
      return null;
    }
  }

  public async listRecentTasks(limit = 10): Promise<TaskKnowledge[]> {
    try {
      return await this.taskKnowledge()
        .find({})
        .sort({ updatedAt: -1 })
        .limit(limit)
        .toArray();
    } catch (err) {
      logger.warn('[MongoService] listRecentTasks failed:', err);
      return [];
    }
  }

  // ─── Active Agent State ──────────────────────────────────────────────────

  public async saveActiveAgentState(data: Omit<ActiveAgentState, '_id' | 'updatedAt'>): Promise<void> {
    try {
      if (!this.isConnected()) return;
      await this.activeStates().updateOne(
        { sessionId: data.sessionId },
        {
          $set: {
            ...data,
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );
    } catch (err) {
      logger.warn('[MongoService] saveActiveAgentState failed:', err);
    }
  }

  public async getLatestActiveAgentState(): Promise<ActiveAgentState | null> {
    try {
      if (!this.isConnected()) return null;
      return await this.activeStates().findOne({}, { sort: { updatedAt: -1 } });
    } catch (err) {
      logger.warn('[MongoService] getLatestActiveAgentState failed:', err);
      return null;
    }
  }
}

export const mongoService = MongoService.getInstance();
