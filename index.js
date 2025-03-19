import express from "express"
import TelegramBot from "node-telegram-bot-api"
import axios from "axios"
import dotenv from "dotenv"
import { stringify } from "csv-stringify/sync"
import fs from "fs"
import http from "http"

dotenv.config()

const AUTHORIZED_GROUP_ID = process.env.AUTHORIZED_GROUP_ID
const EVM_CABAL_GROUP_ID = process.env.EVM_CABAL_GROUP_ID || AUTHORIZED_GROUP_ID
const DUNE_POLL_INTERVAL = 10000 // 10 seconds
const DUNE_MAX_RETRIES = 30
const DUNE_TIMEOUT = 600000 // 10 minutes
const BOT_RESTART_DELAY = 10000 // 10 seconds

const app = express()
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true })
const PORT = process.env.PORT || 8000

// Set up commands menu - Added evmwalletpnl command
bot
  .setMyCommands([
    { command: "start", description: "Start the bot" },
    { command: "cabal", description: "Find Solana token wallets" },
    { command: "walletpnl", description: "Check 30-day wallet profit/loss" },
    { command: "evmcabal", description: "Find EVM token wallets" },
    { command: "evmwalletpnl", description: "Check EVM wallet profit/loss" },
  ])
  .then(() => {
    console.log("Bot commands menu set up successfully")
  })
  .catch((error) => {
    console.error("Error setting up bot commands menu:", error)
  })

// Setup health check with reference to the bot
const server = setupHealthCheck(PORT, bot)

function setupHealthCheck(port, bot) {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      // Check if the bot is actually connected to Telegram
      const isPolling = bot.isPolling()

      if (isPolling) {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            status: "OK",
            timestamp: new Date().toISOString(),
            polling: true,
          }),
        )
      } else {
        res.writeHead(503, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            status: "ERROR",
            message: "Bot is not polling",
            timestamp: new Date().toISOString(),
          }),
        )
      }
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" })
      res.end("Not Found")
    }
  })

  server.listen(port, () => {
    console.log(`Health check server running on port ${port}`)
  })

  return server
}

async function isAuthorizedUser(userId) {
  try {
    const chatMember = await bot.getChatMember(AUTHORIZED_GROUP_ID, userId)
    return ["creator", "administrator", "member"].includes(chatMember.status)
  } catch (error) {
    console.error(`Error checking group membership for user ${userId}:`, error)
    return false
  }
}

async function isAuthorizedForEVMCabal(userId) {
  try {
    const chatMember = await bot.getChatMember(EVM_CABAL_GROUP_ID, userId)
    return ["creator", "administrator", "member"].includes(chatMember.status)
  } catch (error) {
    console.error(`Error checking EVM Cabal group membership for user ${userId}:`, error)
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

  // Updated welcome message with emoji and text changes
  const welcomeMessage = `Welcome to CORESIGHT🔭! your gateway to deep insight and analysis using blockchain data!

To use the CABAL WALLET FINDER, enter /cabal
To use the SOLANA WALLET PNL FINDER, enter /walletpnl
To use the EVM CABAL WALLET FINDER, enter /evmcabal
To use the EVM WALLET PNL FINDER, enter /evmwalletpnl

More comands coming, stay tuned!😉`

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

// Changed from /EVMCabal to /evmcabal (lowercase)
bot.onText(/\/evmcabal/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from.id

  // Check if user is authorized
  if (!(await isAuthorizedForEVMCabal(userId))) {
    bot.sendMessage(
      chatId,
      "Sorry, you are not authorized to use the EVM Cabal command. Please join our authorized group to get access.",
    )
    return
  }

  // Update this message to list available blockchains
  bot.sendMessage(
    chatId,
    "Choose a blockchain to query on. Available Chains are: bnb, base, ethereum, arbitrum, sei, berachain, fantom, polygon, avalanche_c, linea, blast, optimism, zksync",
  )

  // Rest of the command handler remains the same
  bot.once("text", async (blockchainMsg) => {
    if (blockchainMsg.text.startsWith("/")) {
      return // Ignore if it's a command
    }

    const blockchain = blockchainMsg.text.trim().toLowerCase()

    bot.sendMessage(chatId, "Please enter 1-5 token addresses, separated by spaces:")

    bot.once("text", async (tokenMsg) => {
      if (tokenMsg.text.startsWith("/")) {
        return // Ignore if it's a command
      }

      const addresses = tokenMsg.text.split(" ")
      if (addresses.length < 1 || addresses.length > 5) {
        bot.sendMessage(chatId, "Please enter between 1 and 5 token addresses.")
        return
      }

      // Fill remaining slots with "NULL"
      const filledAddresses = [...addresses]
      while (filledAddresses.length < 5) {
        filledAddresses.push("NULL")
      }

      bot.sendMessage(chatId, "Processing your EVM Cabal request. This may take a few minutes, please be patient...")

      queryQueue.push({ chatId, type: "evmcabal", data: { addresses: filledAddresses, blockchain } })
      if (!isProcessingQueue) {
        processQueue()
      }
    })
  })
})

// New command for EVM Wallet PnL
bot.onText(/\/evmwalletpnl/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from.id

  // Check if user is authorized (using the same group as EVMCabal)
  if (!(await isAuthorizedForEVMCabal(userId))) {
    bot.sendMessage(
      chatId,
      "Sorry, you are not authorized to use the EVM Wallet PnL command. Please join our premium group to get access.",
    )
    return
  }

  // Prompt for blockchain selection
  bot.sendMessage(
    chatId,
    "Choose a blockchain to query on. Available Chains are: bnb, base, ethereum, arbitrum, sei, berachain, fantom, polygon, avalanche_c, linea, blast, optimism, zksync",
  )

  bot.once("text", async (blockchainMsg) => {
    if (blockchainMsg.text.startsWith("/")) {
      return // Ignore if it's a command
    }

    const blockchain = blockchainMsg.text.trim().toLowerCase()

    // Prompt for wallet address
    bot.sendMessage(chatId, "Please enter a wallet address for the selected blockchain:")

    bot.once("text", async (walletMsg) => {
      if (walletMsg.text.startsWith("/")) {
        return // Ignore if it's a command
      }

      const walletAddress = walletMsg.text.trim()

      bot.sendMessage(
        chatId,
        "Processing your EVM Wallet PnL request. This may take a few minutes, please be patient...",
      )

      queryQueue.push({ chatId, type: "evmwalletpnl", data: { walletAddress, blockchain } })
      if (!isProcessingQueue) {
        processQueue()
      }
    })
  })
})

// Function to format wallet PnL data as text
function formatWalletPnLAsText(data) {
  // Check if we have data
  if (!data || data.length === 0) {
    return "No data available for this wallet"
  }

  // Log the first data item to see its structure
  console.log("Sample wallet PnL data item:", JSON.stringify(data[0]))

  // Get the wallet address from the query parameters
  const walletAddress = data[0]?.wallet_address || "Unknown"

  // Get the values directly from the first row of data
  // Using the correct column names from the API response
  const buysCount = data[0]?.["buys count"] || 0
  const sellsCount = data[0]?.["sells count"] || 0
  const totalTrades = data[0]?.["total trades"] || 0
  const buysUsd = data[0]?.["Buys($)"] || 0
  const sellsUsd = data[0]?.["Sells($)"] || 0
  const profitUsd = data[0]?.["Profit($)"] || 0
  const profitPercentage = data[0]?.["Profit(%)"] || 0

  // Format the message
  const message = `WALLET 7D PnL
trader👨🏼‍🦰: ${walletAddress}

buys count🟩: ${buysCount}

sells count🔴: ${sellsCount}

total trades💱: ${totalTrades}

Buys($)📈: $${typeof buysUsd === "number" ? buysUsd.toFixed(2) : buysUsd}

Sells($)📉: $${typeof sellsUsd === "number" ? sellsUsd.toFixed(2) : sellsUsd}

Profit($)💸: $${typeof profitUsd === "number" ? profitUsd.toFixed(2) : profitUsd}

Profit(%)🏦: ${typeof profitPercentage === "number" ? profitPercentage.toFixed(2) : profitPercentage}%`

  return message
}

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
    } else if (type === "evmcabal") {
      result = await queryDuneEVMCabal(data.addresses, data.blockchain)
    } else if (type === "evmwalletpnl") {
      result = await queryDuneEVMWalletPNL(data.walletAddress, data.blockchain)
    }

    if (result.length === 0) {
      bot.sendMessage(chatId, "No results found for the given input.")
    } else {
      // Special handling for walletpnl and evmwalletpnl - send as text instead of CSV
      if (type === "walletpnl" || type === "evmwalletpnl") {
        const formattedText = formatWalletPnLAsText(result)
        bot.sendMessage(chatId, formattedText)
      } else {
        // For other types, continue sending CSV files
        const csvContent = createCSVReport(result)
        const fileName = `${type}_results_${Date.now()}.csv`
        fs.writeFileSync(fileName, csvContent)

        await bot.sendDocument(chatId, fileName, { caption: `${type.toUpperCase()} Results` })

        // Delete the file after sending
        fs.unlinkSync(fileName)
      }
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

  const result = await executeDuneQuery("4184506", params)

  // Add the wallet address to each result item for reference
  return result.map((item) => ({
    ...item,
    wallet_address: walletAddress,
  }))
}

async function queryDuneEVMCabal(addresses, blockchain) {
  const params = {
    blockchain: blockchain,
  }

  addresses.forEach((address, index) => {
    params[`Token_${index + 1}`] = address
  })

  return await executeDuneQuery(process.env.EVM_QUERY_ID, params)
}

// New function for EVM Wallet PnL
async function queryDuneEVMWalletPNL(walletAddress, blockchain) {
  const params = {
    wallet_address: walletAddress,
    blockchain: blockchain,
  }

  const result = await executeDuneQuery("4873029", params)

  // Add the wallet address to each result item for reference
  return result.map((item) => ({
    ...item,
    wallet_address: walletAddress,
  }))
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

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM signal received. Closing server...")
  server.close(() => {
    console.log("Server closed.")
    bot.stopPolling()
    console.log("Cabal bot polling stopped...")
  })
})

// Keep-alive mechanism
let lastActivity = Date.now()
const KEEP_ALIVE_INTERVAL = 60000 // 1 minute

function updateActivity() {
  lastActivity = Date.now()
}

// Update activity on bot events
bot.on("message", updateActivity)
bot.on("callback_query", updateActivity)

// Check if bot is still active
setInterval(() => {
  const inactiveTime = Date.now() - lastActivity
  console.log(`Bot inactive for ${Math.floor(inactiveTime / 1000)} seconds`)

  // If inactive for more than 10 minutes, restart polling
  if (inactiveTime > 600000) {
    console.log("Bot inactive for too long. Restarting polling...")
    bot.stopPolling().then(() => {
      setTimeout(() => {
        bot.startPolling()
        console.log("Bot polling restarted due to inactivity")
        updateActivity()
      }, 5000)
    })
  }
}, KEEP_ALIVE_INTERVAL)

// Error handling for polling errors
bot.on("polling_error", (error) => {
  console.log("Polling error:", error.message)
  if (error.message.includes("ETELEGRAM: 409 Conflict") || error.message.includes("ECONNRESET")) {
    console.log("Conflict or connection reset detected. Restarting polling...")
    bot.stopPolling()
    setTimeout(() => {
      bot.startPolling()
      console.log("Cabal bot polling restarted...")
      updateActivity()
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

// Add a ping mechanism to keep the connection alive
setInterval(
  () => {
    console.log("Sending keep-alive ping...")
    bot
      .getMe()
      .then((me) => {
        console.log(`Bot ${me.username} is alive and well`)
        updateActivity()
      })
      .catch((error) => {
        console.error("Error in keep-alive ping:", error)
        // If we can't reach Telegram, restart polling
        bot.stopPolling()
        setTimeout(() => {
          bot.startPolling()
          console.log("Bot polling restarted after failed ping")
          updateActivity()
        }, 5000)
      })
  },
  5 * 60 * 1000,
) // Every 5 minutes

console.log("Cabal bot is created and polling started...")

