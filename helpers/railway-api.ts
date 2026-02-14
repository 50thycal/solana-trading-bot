/**
 * Railway API helper for managing environment variables and deployments.
 *
 * Uses Railway's public GraphQL API at https://backboard.railway.app/graphql/v2
 */

import https from 'https';
import { logger } from './logger';

const RAILWAY_API_URL = 'https://backboard.railway.app/graphql/v2';

interface RailwayConfig {
  apiToken: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
}

interface GraphQLResponse {
  data?: any;
  errors?: Array<{ message: string }>;
}

function getRailwayConfig(): RailwayConfig | null {
  const apiToken = process.env.RAILWAY_API_TOKEN;
  const projectId = process.env.RAILWAY_PROJECT_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  const serviceId = process.env.RAILWAY_SERVICE_ID;

  if (!apiToken || !projectId || !environmentId || !serviceId) {
    return null;
  }

  return { apiToken, projectId, environmentId, serviceId };
}

/**
 * Check if Railway API is configured
 */
export function isRailwayConfigured(): boolean {
  return getRailwayConfig() !== null;
}

/**
 * Execute a GraphQL request against Railway's API
 */
function graphqlRequest(token: string, query: string, variables: Record<string, any>): Promise<GraphQLResponse> {
  const body = JSON.stringify({ query, variables });

  return new Promise((resolve, reject) => {
    const url = new URL(RAILWAY_API_URL);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON response: ${data.substring(0, 200)}`));
          }
        });
      },
    );

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Railway API request timed out'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Upsert multiple environment variables to Railway.
 * Uses variableCollectionUpsert for a single bulk operation.
 */
export async function pushVariablesToRailway(
  variables: Record<string, string>,
): Promise<{ success: boolean; error?: string; updatedCount?: number }> {
  const config = getRailwayConfig();
  if (!config) {
    return { success: false, error: 'Railway API not configured. Set RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, and RAILWAY_SERVICE_ID.' };
  }

  const varCount = Object.keys(variables).length;
  if (varCount === 0) {
    return { success: false, error: 'No variables to push' };
  }

  logger.info({ varCount }, 'Pushing variables to Railway');

  const query = `
    mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }
  `;

  try {
    const response = await graphqlRequest(config.apiToken, query, {
      input: {
        projectId: config.projectId,
        environmentId: config.environmentId,
        serviceId: config.serviceId,
        variables,
        replace: false,
      },
    });

    if (response.errors && response.errors.length > 0) {
      const errMsg = response.errors.map((e) => e.message).join('; ');
      logger.error({ errors: response.errors }, 'Railway API returned errors');
      return { success: false, error: errMsg };
    }

    logger.info({ varCount }, 'Successfully pushed variables to Railway');
    return { success: true, updatedCount: varCount };
  } catch (error: any) {
    logger.error({ error: error.message }, 'Railway API request failed');
    return { success: false, error: error.message };
  }
}

/**
 * Trigger a redeployment of the service on Railway.
 * This restarts the bot with the latest variables.
 */
export async function redeployRailwayService(): Promise<{ success: boolean; error?: string }> {
  const config = getRailwayConfig();
  if (!config) {
    return { success: false, error: 'Railway API not configured. Set RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, and RAILWAY_SERVICE_ID.' };
  }

  logger.info('Triggering Railway service redeploy');

  const query = `
    mutation serviceInstanceRedeploy($environmentId: String!, $serviceId: String!) {
      serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId)
    }
  `;

  try {
    const response = await graphqlRequest(config.apiToken, query, {
      environmentId: config.environmentId,
      serviceId: config.serviceId,
    });

    if (response.errors && response.errors.length > 0) {
      const errMsg = response.errors.map((e) => e.message).join('; ');
      logger.error({ errors: response.errors }, 'Railway redeploy failed');
      return { success: false, error: errMsg };
    }

    logger.info('Railway service redeploy triggered successfully');
    return { success: true };
  } catch (error: any) {
    logger.error({ error: error.message }, 'Railway redeploy request failed');
    return { success: false, error: error.message };
  }
}
