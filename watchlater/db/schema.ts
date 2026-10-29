import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, primaryKey, index, check } from 'drizzle-orm/sqlite-core';

export const recentSaves = sqliteTable('rs_items', {
  ownerId: text('owner_id').notNull(),
  videoUrl: text('video_url').notNull(),
  savedAt: integer('saved_at').notNull(),
  data: text('data').notNull(),
  revision: integer('revision').notNull().default(1),
  localUpdatedAt: integer('local_updated_at').notNull().default(0),
  cloudUpdatedAt: integer('cloud_updated_at').notNull().default(0),
  contentEdited: integer('content_edited').notNull().default(0),
  channelNorm: text('channel_norm').notNull().default(''),
  tagsNorm: text('tags_norm').notNull().default('[]'),
  searchText: text('search_text').notNull().default(''),
}, table => [
  primaryKey({ columns: [table.ownerId, table.videoUrl] }),
  index('rs_items_recent').on(table.ownerId, table.savedAt, table.videoUrl),
  check('rs_items_owner', sql`${table.ownerId} = 'owner'`),
  check('rs_items_data_json', sql`json_valid(${table.data})`),
]);
export const settings = sqliteTable('rs_settings', {
  ownerId: text('owner_id').primaryKey(),
  data: text('data').notNull(),
  revision: integer('revision').notNull().default(1),
}, table => [check('rs_settings_owner', sql`${table.ownerId} = 'owner'`)]);
export const devices = sqliteTable('rs_devices', {
  tokenHash: text('token_hash').primaryKey(),
  ownerId: text('owner_id').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, table => [index('rs_devices_owner').on(table.ownerId), check('rs_devices_owner_partition', sql`${table.ownerId} = 'owner'`)]);
export const tickets = sqliteTable('rs_tickets', {
  tokenHash: text('token_hash').primaryKey(),
  ownerId: text('owner_id').notNull(),
  snapshot: text('snapshot').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, table => [index('rs_tickets_owner').on(table.ownerId), check('rs_tickets_owner_partition', sql`${table.ownerId} = 'owner'`)]);
export const budgets = sqliteTable('rs_budgets', {
  ownerId: text('owner_id').primaryKey(),
  data: text('data').notNull(),
  revision: integer('revision').notNull().default(1),
}, table => [check('rs_budgets_owner', sql`${table.ownerId} = 'owner'`)]);
