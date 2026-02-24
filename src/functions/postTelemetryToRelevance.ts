import { app, InvocationContext } from "@azure/functions";

export async function postTelemetryToRelevance(queueItem: unknown, context: InvocationContext): Promise<void> {
    context.log('Storage queue function processed work item:', queueItem);
}

app.storageQueue('postTelemetryToRelevance', {
    queueName: 'bot-telemetry',
    connection: 'rgstudioagenttelemetry01_STORAGE',
    handler: postTelemetryToRelevance
});
