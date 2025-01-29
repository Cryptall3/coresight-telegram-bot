import TelegramBot from "node-telegram-bot-api"
import axios from "axios"
import { stringify } from "csv-stringify/sync"
import dotenv from "dotenv"
import http from "http"

// Whitelist of authorized user IDs
const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS
  ? process.env.AUTHORIZED_USERS.split(",").map((id) => Number.parseInt(id.trim()))
  : []

// Function to check if a user is authorized
function isAuthorized(userId) {
  return AUTHORIZED_USERS.includes(userId)
}

dotenv.config()

let botInstance = null
let isPolling = false
let pollInterval = null
let lastPollingAttempt = 0
const POLLING_COOLDOWN = 60000 // 1 minute cooldown
const queryQueue = []
let isProcessingQueue = false

function createBot() {
  if (botInstance) {
    botInstance.stopPolling()
  }

  botInstance = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
    polling: false,
  })

  botInstance.on("polling_error", (error) => {
    console.log("Polling error:", error.message)
    if (error.code === "ETELEGRAM" && error.message.includes("Conflict")) {
      console.log("Conflict detected. Stopping polling...")
      stopPolling()
    }
  })

  botInstance.onText(/\/cabal/, async (msg) => {
    const chatId = msg.chat.id
    const userId = msg.from.id

    if (!isAuthorized(userId)) {
      botInstance.sendMessage(chatId, "Sorry, you are not authorized to use this bot.")
      return
    }

    botInstance.sendMessage(chatId, "Please enter 1-5 Solana token addresses, separated by spaces:")

    botInstance.once("text", async (tokenMsg) => {
      if (tokenMsg.text.startsWith("/")) {
        return // Ignore if it's a command
      }

      const addresses = tokenMsg.text.split(" ")
      if (addresses.length < 1 || addresses.length > 5) {
        botInstance.sendMessage(chatId, "Please enter between 1 and 5 token addresses.")
        return
      }

      // Add query to queue
      queryQueue.push({ chatId, addresses })
      botInstance.sendMessage(chatId, "Your request has been queued. Please wait...")

      // Start processing queue if not already processing
      if (!isProcessingQueue) {
        processQueue()
      }
    })
  })

  console.log("Cabal bot is created...")
}

function startPolling() {
  const now = Date.now()
  if (!isPolling && now - lastPollingAttempt > POLLING_COOLDOWN) {
    lastPollingAttempt = now
    botInstance
      .startPolling({ restart: true })
      .then(() => {
        isPolling = true
        console.log("Cabal bot polling started...")
      })
      .catch((error) => {
        console.error("Error starting polling:", error)
        isPolling = false
      })

    // Set up interval to check and restart polling if needed
    if (!pollInterval) {
      pollInterval = setInterval(() => {
        if (!isPolling) {
          console.log("Polling stopped unexpectedly. Attempting to restart...")
          startPolling()
        }
      }, POLLING_COOLDOWN)
    }
  } else {
    console.log("Skipping polling start due to cooldown or already polling")
  }
}

function stopPolling() {
  if (isPolling) {
    botInstance.stopPolling()
    isPolling = false
    console.log("Cabal bot polling stopped...")

    if (pollInterval) {
      clearInterval(pollInterval)
      pollInterval = null
    }

    // Attempt to restart polling after a delay
    setTimeout(() => {
      console.log("Attempting to restart polling...")
      startPolling()
    }, POLLING_COOLDOWN)
  }
}

async function processQueue() {
  if (isProcessingQueue || queryQueue.length === 0) return

  isProcessingQueue = true

  while (queryQueue.length > 0) {
    const { chatId, addresses } = queryQueue.shift()
    try {
      const result = await queryDune(addresses)
      if (result.length === 0) {
        botInstance.sendMessage(chatId, "No results found for the given addresses.")
      } else {
        const csv = stringify(result, { header: true })
        botInstance.sendDocument(chatId, Buffer.from(csv), {
          filename: "cabal_results.csv",
          caption: "Here are your Cabal results:",
        })
      }
    } catch (error) {
      botInstance.sendMessage(chatId, `Error: ${error.message}`)
      console.error("Dune API Error:", error)
    }
  }

  isProcessingQueue = false
}

async function queryDune(addresses, retries = 5, timeout = 300000) {
  const params = {}
  addresses.forEach((address, index) => {
    params[`Token_${index + 1}`] = address
  })

  const startTime = Date.now()

  try {
    console.log("Sending request to Dune API with params:", JSON.stringify(params))
    const executeResponse = await axios.post(
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

    // Poll for results
    while (Date.now() - startTime < timeout) {
      const statusResponse = await axios.get(`https://api.dune.com/api/v1/execution/${executionId}/status`, {
        headers: {
          "x-dune-api-key": process.env.DUNE_API_KEY,
        },
      })

      console.log("Dune API status response:", JSON.stringify(statusResponse.data))

      if (statusResponse.data.state === "QUERY_STATE_COMPLETED") {
        const resultResponse = await axios.get(`https://api.dune.com/api/v1/execution/${executionId}/results`, {
          headers: {
            "x-dune-api-key": process.env.DUNE_API_KEY,
          },
        })

        console.log("Dune API result response:", JSON.stringify(resultResponse.data))

        return resultResponse.data.result.rows
      } else if (statusResponse.data.state === "QUERY_STATE_FAILED") {
        throw new Error("Query execution failed")
      }

      // Wait before polling again
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }

    throw new Error("Query execution timed out")
  } catch (error) {
    console.error("Dune API Error:", error.response ? JSON.stringify(error.response.data) : error.message)
    if (retries > 0 && Date.now() - startTime <= timeout) {
      console.log(`Error occurred. Retrying in 30 seconds... (${retries} retries left)`)
      await new Promise((resolve) => setTimeout(resolve, 30000))
      return queryDune(addresses, retries - 1, timeout - (Date.now() - startTime))
    }
    throw new Error("Failed to execute Dune query after multiple attempts. Please try again later.")
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200)
  res.end("Health check passed")
})

server.listen(8000, () => {
  console.log("Health check server running on port 8000")
  createBot()
  startPolling()
})

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM signal received. Closing HTTP server and stopping bot...")
  server.close(() => {
    console.log("HTTP server closed.")
  })
  if (botInstance) {
    stopPolling()
  }
})

