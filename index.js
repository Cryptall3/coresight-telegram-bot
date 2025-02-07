import express from "express"
import http from "http"
import TelegramBot from "node-telegram-bot-api"
import axios from "axios"
import dotenv from "dotenv"
import { stringify } from "csv-stringify/sync"
import fs from "fs"

dotenv.config()

const AUTHORIZED_GROUP_ID = process.env.AUTHORIZED_GROUP_ID
const DUNE_POLL_INTERVAL = 10000 // 10 seconds
const DUNE_MAX_RETRIES = 30
const DUNE_TIMEOUT = 600000 // 10 minutes
const BOT_RESTART_DELAY = 10000 // 10 seconds

const app = express()
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true })
const PORT = process.env.PORT || 8000

async function isAuthorizedUser(userId) {
  try {
    console.log(`Checking authorization for user ${userId}`)
    console.log(`Current AUTHORIZED_GROUP_ID: ${AUTHORIZED_GROUP_ID}`)

    let chatMember
    try {
      chatMember = await bot.getChatMember(AUTHORIZED_GROUP_ID, userId)
    } catch (error) {
      console.error(`Error getting chat member with current AUTHORIZED_GROUP_ID: ${error.message}`)

      // Try with -100 prefix if not already present
      if (!AUTHORIZED_GROUP_ID.startsWith("-100")) {
        const alternativeGroupId = `-100${AUTHORIZED_GROUP_ID.replace("-", "")}`
        console.log(`Trying alternative group ID: ${alternativeGroupId}`)
        try {
          chatMember = await bot.getChatMember(alternativeGroupId, userId)
        } catch (innerError) {
          console.error(`Error getting chat member with alternative group ID: ${innerError.message}`)
        }
      }
    }

    if (chatMember) {
      console.log(`Authorization check for user ${userId}: ${chatMember.status}`)
      return ["creator", "administrator", "member"].includes(chatMember.status)
    } else {
      console.log(`Unable to get chat member status for user ${userId}`)
      return false
    }
  } catch (error) {
    console.error(`Error checking group membership for user ${userId}:`, error)
    return false
  }
}

const queryQueue = []
let isProcessingQueue = false

app.use(express.json())

app.post(`/bot${process.env.TELEGRAM_BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body)
  res.sendStatus(200)
})

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from.id

  if (!(await isAuthorizedUser(userId))) {
    bot.sendMessage(
      chatId,
      "Sorry, you are not authorized to use this bot. Please join our authorized group to get access.",
    )
    return
  }

  const welcomeMessage = `Welcome to CORESIGHT! your gateway to deep insight and analysis using blockchain data!

To use the CABAL WALLET FINDER, enter /cabal
To use the 30D WALLET PNL FINDER, enter /walletpnl

More comands coming, stay tuned!`

  bot.sendMessage(chatId, welcomeMessage)
})

bot.onText(/\/cabal/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from.id

  if (!(await isAuthorizedUser(userId))) {
    bot.sendMessage(
      chatId,
      "Sorry, you are not authorized to use this bot. Please join our authorized group to get access.",
    )
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

    bot.sendMessage(chatId, "Processing your request. This may take a few minutes, please be patient...")

    queryQueue.push({ chatId, type: "cabal", data: addresses })
    if (!isProcessingQueue) {
      processQueue()
    }
  })
})

bot.onText(/\/walletpnl/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from.id

  if (!(await isAuthorizedUser(userId))) {
    bot.sendMessage(
      chatId,
      "Sorry, you are not authorized to use this bot. Please join our authorized group to get access.",
    )
    return
  }

  bot.sendMessage(chatId, "Please enter a Solana wallet address:")

  bot.once("text", async (walletMsg) => {
    if (walletMsg.text.startsWith("/")) {
      return // Ignore if it's a command
    }

    const walletAddress = walletMsg.text.trim()

    bot.sendMessage(chatId, "Processing your request. This may take a few minutes, please be patient...")

    queryQueue.push({ chatId, type: "walletpnl", data: walletAddress })
    if (!isProcessingQueue) {
      processQueue()
    }
  })
})

bot.onText(/\/checkaccess/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from.id

  try {
    const isAuthorized = await isAuthorizedUser(userId)
    bot.sendMessage(chatId, `Authorization check result: ${isAuthorized ? "Authorized" : "Not authorized"}`)
    bot.sendMessage(chatId, `Current AUTHORIZED_GROUP_ID: ${AUTHORIZED_GROUP_ID}`)
    bot.sendMessage(chatId, `Your user ID: ${userId}`)
    bot.sendMessage(chatId, `Current chat ID: ${chatId}`)
    console.log(
      `Access check for user ${userId} in chat ${chatId}. Result: ${isAuthorized ? "Authorized" : "Not authorized"}`,
    )
  } catch (error) {
    bot.sendMessage(chatId, `Error checking your status: ${error.message}`)
    console.error(`Error checking status for user ${userId}:`, error)
  }
})

bot.onText(/\/checkgroupid/, (msg) => {
  const chatId = msg.chat.id
  bot.sendMessage(chatId, `The current chat ID is: ${chatId}`)
  console.log(`Chat ID check requested. Chat ID: ${chatId}`)
})

async function processQueue() {
  if (queryQueue.length === 0) {
    isProcessingQueue = false
    return
  }

  isProcessingQueue = true
  const { chatId, type, data } = queryQueue.shift()

  try {
    let result
    if (type === "cabal") {
      result = await queryDune(data)
    } else if (type === "walletpnl") {
      result = await queryDuneWalletPNL(data)
    }

    if (result.length === 0) {
      bot.sendMessage(chatId, "No results found for the given input.")
    } else {
      const csvContent = createCSVReport(result)
      const fileName = `${type}_results_${Date.now()}.csv`
      fs.writeFileSync(fileName, csvContent)

      await bot.sendDocument(chatId, fileName, { caption: `${type.toUpperCase()} Results` })

      // Delete the file after sending
      fs.unlinkSync(fileName)
    }
  } catch (error) {
    console.error("Dune API Error:", error)
    bot.sendMessage(chatId, `Error: ${error.message}. Please try again later.`)
  }

  setTimeout(processQueue, 1000) // Add a small delay between processing queue items
}

function createCSVReport(data) {
  if (data.length === 0) {
    return "No data available"
  }

  // Get all unique keys from the data
  const allKeys = [...new Set(data.flatMap(Object.keys))]

  // Create header row
  const header = allKeys

  // Create data rows
  const rows = data.map((item) =>
    allKeys.map((key) => {
      if (typeof item[key] === "number") {
        // Format numbers to 2 decimal places
        return item[key].toFixed(2)
      }
      return item[key] || "" // Use empty string for missing values
    }),
  )

  // Combine header and rows
  const csvData = [header, ...rows]

  return stringify(csvData)
}

async function queryDune(addresses) {
  const params = {}
  addresses.forEach((address, index) => {
    params[`Token_${index + 1}`] = address
  })

  return await executeDuneQuery(process.env.QUERY_ID, params)
}

async function queryDuneWalletPNL(walletAddress) {
  const params = {
    wallet_address: walletAddress,
  }

  return await executeDuneQuery("4184506", params)
}

async function executeDuneQuery(queryId, params) {
  const startTime = Date.now()

  try {
    console.log(`Sending request to Dune API for query ${queryId} with params:`, JSON.stringify(params))
    const executeResponse = await axiosWithBackoff.post(
      `https://api.dune.com/api/v1/query/${queryId}/execute`,
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

        return resultResponse.data.result.rows
      } else if (statusResponse.data.state === "QUERY_STATE_FAILED") {
        throw new Error(`Query execution failed: ${statusResponse.data.error || "Unknown error"}`)
      }
    }

    throw new Error("Max retries reached. Query execution incomplete.")
  } catch (error) {
    console.error("Dune API Error:", error.response ? JSON.stringify(error.response.data) : error.message)
    throw new Error("Failed to execute Dune query. Please try again later.")
  }
}

// Simple health check server
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" })
    res.end("OK")
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("Not Found")
  }
})

server.listen(PORT, () => {
  console.log(`Health check server running on port ${PORT}`)
})

console.log("Cabal bot is created...")
console.log("Cabal bot polling started...")

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM signal received. Closing server...")
  server.close(() => {
    console.log("Server closed.")
    bot.stopPolling()
    console.log("Cabal bot polling stopped...")
  })
})

// Error handling for polling errors
bot.on("polling_error", (error) => {
  console.log("Polling error:", error.message)
  if (error.message.includes("ETELEGRAM: 409 Conflict") || error.message.includes("ECONNRESET")) {
    console.log("Conflict or connection reset detected. Restarting polling...")
    bot.stopPolling()
    setTimeout(() => {
      bot.startPolling()
      console.log("Cabal bot polling restarted...")
    }, BOT_RESTART_DELAY)
  }
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
      const delay = initialDelay * Math.pow(2, retries)
      console.log(`Retrying in ${delay}ms... (Attempt ${retries} of ${maxRetries})`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

// Wrap axios requests with exponential backoff
const axiosWithBackoff = {
  get: (...args) => exponentialBackoff(() => axios.get(...args)),
  post: (...args) => exponentialBackoff(() => axios.post(...args)),
}

console.log("Cabal bot is created and polling started...")

