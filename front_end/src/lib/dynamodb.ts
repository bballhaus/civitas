/**
 * DynamoDB document client singleton, mirroring the s3.ts pattern.
 * Uses default AWS credential provider chain — same env vars as S3.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { config } from "./config";

let _client: DynamoDBDocumentClient | null = null;

export function getDynamoClient(): DynamoDBDocumentClient {
  if (!_client) {
    const base = new DynamoDBClient({ region: config.aws.region });
    _client = DynamoDBDocumentClient.from(base, {
      marshallOptions: {
        removeUndefinedValues: true,
        convertEmptyValues: false,
      },
    });
  }
  return _client;
}

export function getKpiEventsTable(): string {
  return config.kpi.eventsTable;
}

export function getKpiUsersTable(): string {
  return config.kpi.usersTable;
}
