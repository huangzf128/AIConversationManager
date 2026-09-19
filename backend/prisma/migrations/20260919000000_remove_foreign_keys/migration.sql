-- RedefineTables
PRAGMA defer_foreign_keys = ON;

PRAGMA foreign_keys = OFF;

CREATE TABLE "new_Attachment" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"messageId" TEXT NOT NULL,
	"displayName" TEXT NOT NULL,
	"storagePath" TEXT NOT NULL,
	"contentHash" TEXT NOT NULL,
	"size" INTEGER NOT NULL,
	"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO
	"new_Attachment" (
		"contentHash",
		"createdAt",
		"displayName",
		"id",
		"messageId",
		"size",
		"storagePath"
	)
SELECT
	"contentHash",
	"createdAt",
	"displayName",
	"id",
	"messageId",
	"size",
	"storagePath"
FROM
	"Attachment";

DROP TABLE "Attachment";

ALTER TABLE
	"new_Attachment" RENAME TO "Attachment";

CREATE UNIQUE INDEX "Attachment_messageId_contentHash_key" ON "Attachment"("messageId", "contentHash");

CREATE TABLE "new_Conversation" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"platform" TEXT NOT NULL,
	"title" TEXT NOT NULL,
	"hidden" BOOLEAN NOT NULL DEFAULT false,
	"starred" BOOLEAN NOT NULL DEFAULT false,
	"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updatedAt" DATETIME NOT NULL
);

INSERT INTO
	"new_Conversation" (
		"createdAt",
		"hidden",
		"id",
		"platform",
		"title",
		"updatedAt"
	)
SELECT
	"createdAt",
	"hidden",
	"id",
	"platform",
	"title",
	"updatedAt"
FROM
	"Conversation";

DROP TABLE "Conversation";

ALTER TABLE
	"new_Conversation" RENAME TO "Conversation";

CREATE TABLE "new_Message" (
	"id" TEXT NOT NULL PRIMARY KEY,
	"role" TEXT NOT NULL,
	"content" TEXT NOT NULL,
	"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"hidden" BOOLEAN NOT NULL DEFAULT false,
	"parentMessageId" TEXT,
	"conversationId" TEXT NOT NULL
);

INSERT INTO
	"new_Message" (
		"content",
		"conversationId",
		"createdAt",
		"hidden",
		"id",
		"parentMessageId",
		"role"
	)
SELECT
	"content",
	"conversationId",
	"createdAt",
	"hidden",
	"id",
	"parentMessageId",
	"role"
FROM
	"Message";

DROP TABLE "Message";

ALTER TABLE
	"new_Message" RENAME TO "Message";

PRAGMA foreign_keys = ON;

PRAGMA defer_foreign_keys = OFF;