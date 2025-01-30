import express from "express"
import TelegramBot from "node-telegram-bot-api"
import axios from "axios"
import { stringify } from "csv-stringify/sync"
import dotenv from "dotenv"

dotenv.config()

const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS
  ? process.env.AUTHORIZED_USERS.split(",").map((id) => Number.parseInt(id.trim()))
  : []
const DUNE_POLL_INTERVAL = 10000 // 10 seconds
const DUNE_MAX_RETRIES = 30
const DUNE_TIMEOUT = 600000 // 10 minutes
const BOT_RESTART_DELAY = 30000 // 30 seconds

const app = express()
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN)
const PORT = process.env.PORT || 8000

function isAuthorized(userId) {
  return AUTHORIZED_USERS.includes(userId)
}

const queryQueue = []
let isProcessingQueue = false

app.use(express.json())

app.post(`/bot${process.env.TELEGRAM_BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body)
  res.sendStatus(200)
})

bot.onText(/\/cabal/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from.id

  if (!isAuthorized(userId)) {
    bot.sendMessage(chatId, "Sorry, you are not authorized to use this bot.")
    return
  }

  bot.sendMessage(chatId, "Please enter 1-5 Solana token addresses, separated by spaces:")

  bot.once("text", async (tokenMsg) => {
    if (tokenMsg.text.startsWith("/")) {
      return // Ignore if it's a command
    }

    const addresses = tokenMsg.text.split(" ")
    if (addresses.length < 1 || addresses.length > 5) {
      bot.sendMessage(chatId, "Please enter between 1 and 5 token addresses.")
      return
    }

    bot.sendMessage(chatId, "Processing your request. This may take up to 10 minutes, please be patient...")

    queryQueue.push({ chatId, addresses })
    if (!isProcessingQueue) {
      processQueue()
    }
  })
})

async function processQueue() {
  if (queryQueue.length === 0) {
    isProcessingQueue = false
    return
  }

  isProcessingQueue = true
  const { chatId, addresses } = queryQueue.shift()

  try {
    const result = await queryDune(addresses)
    if (result.length === 0) {
      bot.sendMessage(chatId, "No results found for the given addresses.")
    } else {
      const csv = stringify(result, { header: true })
      const buffer = Buffer.from(csv, "utf8")
      await bot.sendDocument(
        chatId,
        buffer,
        {
          filename: "cabal_results.csv",
          caption: "Here are your Cabal results:",
        },
        {
          contentType: "text/csv",
        },
      )
    }
  } catch (error) {
    console.error("Dune API Error:", error)
    bot.sendMessage(chatId, `Error: ${error.message}. Please try again later.`)
  }

  setTimeout(processQueue, 5000) // Add a 5-second delay between processing queue items
}

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

        // Process the data to match the desired schema
        const processedData = resultResponse.data.result.rows.map((row) => ({
          token1_name: row.token1_name || null,
          token1_total_pnl_percentage: row.token1_total_pnl_percentage ? `${row.token1_total_pnl_percentage}%` : null,
          token1_total_pnl_usd: row.token1_total_pnl_usd ? `$${row.token1_total_pnl_usd}` : null,
          token2_name: row.token2_name || null,
          token2_total_pnl_percentage: row.token2_total_pnl_percentage ? `${row.token2_total_pnl_percentage}%` : null,
          token2_total_pnl_usd: row.token2_total_pnl_usd ? `$${row.token2_total_pnl_usd}` : null,
          token3_name: row.token3_name || null,
          token3_total_pnl_percentage: row.token3_total_pnl_percentage ? `${row.token3_total_pnl_percentage}%` : null,
          token3_total_pnl_usd: row.token3_total_pnl_usd ? `$${row.token3_total_pnl_usd}` : null,
          token4_name: null,
          token4_total_pnl_percentage: null,
          token4_total_pnl_usd: null,
          token5_name: null,
          token5_total_pnl_percentage: null,
          token5_total_pnl_usd: null,
          total_pnl_percentage: row.total_pnl_percentage ? `${row.total_pnl_percentage}%` : null,
          total_pnl_usd: row.total_pnl_usd ? `$${row.total_pnl_usd}` : null,
          trader: row.trader || null,
        }))

        return processedData
      } else if (statusResponse.data.state === "QUERY_STATE_FAILED") {
        throw new Error("Query execution failed")
      }
    }

    throw new Error("Max retries reached. Query execution incomplete.")
  } catch (error) {
    console.error("Dune API Error:", error.response ? JSON.stringify(error.response.data) : error.message)
    throw new Error("Failed to execute Dune query. Please try again later.")
  }
}

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
  bot.setWebHook(`${process.env.WEBHOOK_URL}/bot${process.env.TELEGRAM_BOT_TOKEN}`)
})

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM signal received. Closing server...")
  server.close(() => {
    console.log("Server closed.")
  })
})

// Implement exponential backoff for API requests
async function exponentialBackoff(fn, maxRetries = 5, initialDelay = 1000) {
  let retries = 0
  while (retries < maxRetries) {
    try {
      return await fn()
    } catch (error) {
      retries++
      if (retries === maxRetries) throw error
      await new Promise((resolve) => setTimeout(resolve, initialDelay * Math.pow(2, retries)))
    }
  }
}

// Wrap axios requests with exponential backoff
const axiosWithBackoff = {
  get: (...args) => exponentialBackoff(() => axios.get(...args)),
  post: (...args) => exponentialBackoff(() => axios.post(...args)),
}

console.log("Cabal bot is created and webhook is set...")

