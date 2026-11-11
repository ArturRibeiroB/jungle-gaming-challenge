#!/bin/bash
# Cria as filas FIFO do desafio. Roda quando o LocalStack fica pronto.
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
DLQ_NAME="wager-transactions-dlq.fifo"
QUEUE_NAME="wager-transactions.fifo"
MAX_RECEIVE_COUNT=5

awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name "$DLQ_NAME" \
  --attributes '{"FifoQueue":"true","MessageRetentionPeriod":"1209600"}'

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --region "$REGION" \
  --queue-url "$(awslocal sqs get-queue-url --region "$REGION" --queue-name "$DLQ_NAME" --query QueueUrl --output text)" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name "$QUEUE_NAME" \
  --attributes "{\"FifoQueue\":\"true\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"$MAX_RECEIVE_COUNT\\\"}\"}"

echo "SQS queues ready: $QUEUE_NAME -> $DLQ_NAME (maxReceiveCount=$MAX_RECEIVE_COUNT)"
