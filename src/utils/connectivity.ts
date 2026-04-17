/**
 * Utility for checking internet connectivity using third-party endpoints
 */

export type ConnectivityCheckResult = {
  /** Whether internet connectivity was detected */
  connected: boolean;
  /** Detailed results for each endpoint tested */
  endpointResults: Array<{
    /** The endpoint URL that was tested */
    endpoint: string;
    /** Error message if request failed */
    error?: string;
    /** Time taken for the request in milliseconds */
    latencyMs?: number;
    /** HTTP status code if request succeeded */
    statusCode?: number;
    /** Whether this endpoint was reachable */
    success: boolean;
  }>;
  /** Summary message for developers */
  message: string;
};

/**
 * Check if the system has internet connectivity by testing against
 * multiple reliable third-party endpoints with detailed diagnostics.
 *
 * @returns Promise<ConnectivityCheckResult> - Detailed connectivity check results
 */
export async function checkInternetConnectivity(): Promise<ConnectivityCheckResult> {
  // Use multiple reliable endpoints to test connectivity
  const testEndpoints = [
    { url: 'https://www.google.com/generate_204', description: 'Google' },
    { url: 'https://www.cloudflare.com/cdn-cgi/trace', description: 'Cloudflare' },
    { url: 'https://1.1.1.1/', description: 'Cloudflare DNS' },
  ];

  const endpointResults: ConnectivityCheckResult['endpointResults'] = [];
  let anySuccess = false;

  // Try each endpoint with a short timeout
  for (const { url, description } of testEndpoints) {
    const startTime = Date.now();
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout

      const response = await fetch(url, {
        method: 'HEAD', // Use HEAD to minimize data transfer
        signal: controller.signal,
        // Disable redirects to get faster response
        redirect: 'manual',
      });

      clearTimeout(timeoutId);
      const latencyMs = Date.now() - startTime;

      // Any response (including 3xx redirects) indicates connectivity
      if (response) {
        anySuccess = true;
        endpointResults.push({
          endpoint: `${description} (${url})`,
          success: true,
          statusCode: response.status,
          latencyMs,
        });
        // Found working connection, no need to test more
        break;
      }
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      let errorMessage = 'Unknown error';

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          errorMessage = 'Request timeout (>3s)';
        } else if (error.message.includes('fetch failed')) {
          errorMessage = 'Network request failed (DNS/connection error)';
        } else if (error.message.includes('ENOTFOUND')) {
          errorMessage = 'DNS resolution failed';
        } else if (error.message.includes('ECONNREFUSED')) {
          errorMessage = 'Connection refused';
        } else if (error.message.includes('ETIMEDOUT')) {
          errorMessage = 'Connection timeout';
        } else if (error.message.includes('ENETUNREACH')) {
          errorMessage = 'Network unreachable';
        } else {
          errorMessage = error.message;
        }
      }

      endpointResults.push({
        endpoint: `${description} (${url})`,
        success: false,
        error: errorMessage,
        latencyMs,
      });
      // Continue to next endpoint if this one fails
      continue;
    }
  }

  // Generate developer-friendly message
  let message: string;
  if (anySuccess) {
    const successfulEndpoint = endpointResults.find((r) => r.success);
    message = `Internet connectivity verified via ${successfulEndpoint?.endpoint} (${successfulEndpoint?.latencyMs}ms)`;
  } else {
    const testedEndpoints = endpointResults.map((r) => r.endpoint).join(', ');
    message = `No internet connectivity detected. Tested endpoints: ${testedEndpoints}`;
  }

  return {
    connected: anySuccess,
    endpointResults,
    message,
  };
}
