const axios = require("axios")
const axiosWithBackoff = axios.create({
  retry: 3,
  retryDelay: 1000,
  shouldRetry: (error) => {
    // Retry only if the error is a network error or a timeout error
    return error.response === undefined || error.response.status >= 500
  },
})

async function queryDune(addresses) {
  const params = {}
  addresses.forEach((address, index) => {
    params[`Token_${index + 1}`] = address
  })

  const startTime = Date.now()

  try {
    console.log("Sending request to Dune API with params:", JSON.stringify(params))
    const executeResponse = await axiosWithBackoff.post(
      `https://api.dune.com/api/v1/query/${process.env.QUERY_ID}/execute`,
      {
        query_parameters: params,
      },
      {
        headers: {
          "x-dune-api-key": process.env.DUNE_API_KEY,
        },
      },
    )

    console.log("Dune API execute response:", JSON.stringify(executeResponse.data))

    const executionId = executeResponse.data.execution_id

    for (let i = 0; i < DUNE_MAX_RETRIES; i++) {
      if (Date.now() - startTime > DUNE_TIMEOUT) {
        throw new Error("Query execution timed out")
      }

      await new Promise((resolve) => setTimeout(resolve, DUNE_POLL_INTERVAL))

      const statusResponse = await axiosWithBackoff.get(`https://api.dune.com/api/v1/execution/${executionId}/status`, {
        headers: {
          "x-dune-api-key": process.env.DUNE_API_KEY,
        },
      })

      console.log("Dune API status response:", JSON.stringify(statusResponse.data))

      if (statusResponse.data.state === "QUERY_STATE_COMPLETED") {
        const resultResponse = await axiosWithBackoff.get(
          `https://api.dune.com/api/v1/execution/${executionId}/results`,
          {
            headers: {
              "x-dune-api-key": process.env.DUNE_API_KEY,
            },
          },
        )

        console.log("Dune API result response:", JSON.stringify(resultResponse.data))

        if (!resultResponse.data.result || !resultResponse.data.result.rows) {
          throw new Error("Unexpected response format from Dune API")
        }

        // Process the data to match the desired schema exactly
        const processedData = resultResponse.data.result.rows.map((row) => ({
          token1_name: row.token1_name || null,
          token1_total_pnl_percentage:
            row.token1_total_pnl_percentage !== undefined
              ? `${Number.parseFloat(row.token1_total_pnl_percentage).toFixed(3)}%`
              : null,
          token1_total_pnl_usd:
            row.token1_total_pnl_usd !== undefined
              ? `$${Number.parseFloat(row.token1_total_pnl_usd).toFixed(3)}`
              : null,
          token2_name: row.token2_name || null,
          token2_total_pnl_percentage:
            row.token2_total_pnl_percentage !== undefined
              ? `${Number.parseFloat(row.token2_total_pnl_percentage).toFixed(3)}%`
              : null,
          token2_total_pnl_usd:
            row.token2_total_pnl_usd !== undefined
              ? `$${Number.parseFloat(row.token2_total_pnl_usd).toFixed(3)}`
              : null,
          token3_name: row.token3_name || null,
          token3_total_pnl_percentage:
            row.token3_total_pnl_percentage !== undefined
              ? `${Number.parseFloat(row.token3_total_pnl_percentage).toFixed(3)}%`
              : null,
          token3_total_pnl_usd:
            row.token3_total_pnl_usd !== undefined
              ? `$${Number.parseFloat(row.token3_total_pnl_usd).toFixed(3)}`
              : null,
          token4_name: null,
          token4_total_pnl_percentage: null,
          token4_total_pnl_usd: null,
          token5_name: null,
          token5_total_pnl_percentage: null,
          token5_total_pnl_usd: null,
          total_pnl_percentage:
            row.total_pnl_percentage !== undefined
              ? `${Number.parseFloat(row.total_pnl_percentage).toFixed(3)}%`
              : null,
          total_pnl_usd: row.total_pnl_usd !== undefined ? `$${Number.parseFloat(row.total_pnl_usd).toFixed(3)}` : null,
          trader: row.trader || null,
        }))

        return processedData
      } else if (statusResponse.data.state === "QUERY_STATE_FAILED") {
        throw new Error(`Query execution failed: ${statusResponse.data.error || "Unknown error"}`)
      }
    }

    throw new Error("Max retries reached. Query execution incomplete.")
  } catch (error) {
    console.error("Dune API Error:", error)
    if (error.response) {
      console.error("Error response:", JSON.stringify(error.response.data))
      throw new Error(`Dune API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`)
    } else if (error.request) {
      console.error("No response received:", error.request)
      throw new Error("No response received from Dune API")
    } else {
      throw error
    }
  }
}

const DUNE_MAX_RETRIES = 5
const DUNE_TIMEOUT = 60000 // 60 seconds
const DUNE_POLL_INTERVAL = 5000 // 5 seconds

module.exports = { queryDune }

