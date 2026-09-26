import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const region = process.env.AWS_REGION ?? 'eu-west-1';

export const TABLE_NAME = process.env.TABLE_NAME ?? 'packaging-benchmark-orders';
export const BUCKET_NAME = process.env.BUCKET_NAME ?? 'packaging-benchmark-documents';

const rawDynamo = new DynamoDBClient({ region, maxAttempts: 3 });

export const documents = DynamoDBDocumentClient.from(rawDynamo, {
  marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
  unmarshallOptions: { wrapNumbers: false }
});

export const objects = new S3Client({ region, maxAttempts: 3 });

export type StoredRecord = Record<string, unknown> & { pk: string; sk: string };

export const getRecord = async (pk: string, sk: string) => {
  const result = await documents.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk, sk } }));
  return (result.Item ?? null) as StoredRecord | null;
};

export const putRecord = async (item: StoredRecord) => {
  await documents.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return item;
};

export const bumpCounter = async (pk: string, sk: string, attribute: string) => {
  const result = await documents.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk, sk },
      UpdateExpression: 'SET #a = if_not_exists(#a, :zero) + :one',
      ExpressionAttributeNames: { '#a': attribute },
      ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
      ReturnValues: 'UPDATED_NEW'
    })
  );
  return result.Attributes ?? {};
};

export const queryPartition = async (pk: string, limit = 50) => {
  const result = await documents.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': pk },
      Limit: limit,
      ScanIndexForward: false
    })
  );
  return (result.Items ?? []) as StoredRecord[];
};

export const putDocument = async (key: string, body: string, contentType = 'application/json') => {
  await objects.send(
    new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, Body: body, ContentType: contentType })
  );
  return `s3://${BUCKET_NAME}/${key}`;
};

export const readDocument = async (key: string) => {
  const result = await objects.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
  return result.Body ? await result.Body.transformToString() : null;
};
