-- Un cliente puede existir sin acceso al portal: en ese caso no hay email.
-- El indice unique se mantiene; Postgres admite multiples NULL en un unique.
-- AlterTable
ALTER TABLE "Client" ALTER COLUMN "email" DROP NOT NULL;
