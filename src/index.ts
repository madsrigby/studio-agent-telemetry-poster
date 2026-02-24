import { app } from '@azure/functions';

// Ensure all function handlers are loaded in the v4 programming model.
import './functions/Analyticsfunction';
import './functions/postTelemetryToRelevance';

app.setup({
    enableHttpStream: true,
});
