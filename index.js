import TelegramBot from "node-telegram-bot-api"
import axios from "axios"
import { stringify } from "csv-stringify/sync"
import dotenv from "dotenv"
import http from "http"

dotenv.config()

const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS
  ? process.env.AUTHORIZED_USERS.split(",").map((id) => Number.parseInt(id.trim()))
  : []
const POLLING_COOLDOWN = 60000 // 1 minute cooldown
const DUNE_POLL_INTERVAL = 2000 // 2 seconds
const DUNE_MAX_RETRIES = 10
const DUNE_TIMEOUT = 180000 // 3 minutes

let botInstance = null
let isPolling = false
let pollInterval = null
let lastPollingAttempt = 0
const queryQueue = []
let isProcessingQueue = false

function isAuthorized(userId) {
  return AUTHORIZED_USERS.includes(userId)
}

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

      queryQueue.push({ chatId, addresses })
      botInstance.sendMessage(chatId, "Your request has been queued. Please wait...")

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

async function queryDune(addresses) {
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

    for (let i = 0; i < DUNE_MAX_RETRIES; i++) {
      if (Date.now() - startTime > DUNE_TIMEOUT) {
        throw new Error("Query execution timed out")
      }

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

      await new Promise((resolve) => setTimeout(resolve, DUNE_POLL_INTERVAL))
    }

    throw new Error("Max retries reached. Query execution incomplete.")
  } catch (error) {
    console.error("Dune API Error:", error.response ? JSON.stringify(error.response.data) : error.message)
    throw new Error("Failed to execute Dune query. Please try again later.")
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

process.on("SIGTERM", () => {
  console.log("SIGTERM signal received. Closing HTTP server and stopping bot...")
  server.close(() => {
    console.log("HTTP server closed.")
  })
  if (botInstance) {
    stopPolling()
  }
})

