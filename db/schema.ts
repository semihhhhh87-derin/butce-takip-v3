import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const budgetState = sqliteTable("budget_state", {
  id: text("id").primaryKey(),
  payload: text("payload").notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
});
