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
    const chatMember = await bot.getChatMember(AUTHORIZED_GROUP_ID, userId)
    return ["creator", "administrator", "member"].includes(chatMember.status)
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

// Add error handling for uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit the process, just log the error
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit the process, just log the error
});

// Keep-alive mechanism
let lastActivity = Date.now();
const KEEP_ALIVE_INTERVAL = 60000; // 1 minute

function updateActivity() {
  lastActivity = Date.now();
}

// Update activity on bot events
bot.on('message', updateActivity);
bot.on('callback_query', updateActivity);

// Check if bot is still active
setInterval(() => {
  const inactiveTime = Date.now() - lastActivity;
  console.log(`Bot inactive for ${Math.floor(inactiveTime/1000)} seconds`);
  
  // If inactive for more than 10 minutes, restart polling
  if (inactiveTime > 600000) {
    console.log("Bot inactive for too long. Restarting polling...");
    bot.stopPolling().then(() => {
      setTimeout(() => {
        bot.startPolling();
        console.log("Bot polling restarted due to inactivity");
        updateActivity();
      }, 5000);
    });
  }
}, KEEP_ALIVE_INTERVAL);

// Add a ping mechanism to keep the connection alive
setInterval(() => {
  console.log("Sending keep-alive ping...");
  bot.getMe().then(me => {
    console.log(`Bot ${me.username} is alive and well`);
    updateActivity();
  }).catch(error => {
    console.error("Error in keep-alive ping:", error);
    // If we can't reach Telegram, restart polling
    bot.stopPolling();
    setTimeout(() => {
      bot.startPolling();
      console.log("Bot polling restarted after failed ping");
      updateActivity();
    }, 5000);
  });
}, 5 * 60 * 1000); // Every 5 minutes

console.log("Cabal bot is created and polling started...")