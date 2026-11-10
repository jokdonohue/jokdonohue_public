import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const trainingStates = sqliteTable("training_states", {
  userId: text("user_id").primaryKey(),
  state: text("state").notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
});
