import { app } from '@azure/functions';

// Ensure all function handlers are loaded in the v4 programming model.
import './functions/Analyticsfunction';
import './functions/postTelemetryToRelevance';
import './functions/biApi';
import './functions/adminAggregate';

app.setup({
    enableHttpStream: true,
});
