CREATE TABLE IF NOT EXISTS "vault_document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"blob_key" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"page_count" integer,
	"expiry_date" date,
	"replaced_by" uuid,
	"replaced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vault_documents" ADD COLUMN "content_sha256" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vault_document_versions" ADD CONSTRAINT "vault_document_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vault_document_versions" ADD CONSTRAINT "vault_document_versions_document_id_vault_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."vault_documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vault_document_versions" ADD CONSTRAINT "vault_document_versions_replaced_by_users_id_fk" FOREIGN KEY ("replaced_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vault_versions_org_idx" ON "vault_document_versions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vault_versions_doc_idx" ON "vault_document_versions" USING btree ("document_id","replaced_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vault_org_sha_idx" ON "vault_documents" USING btree ("org_id","content_sha256");