import TelegramBot from "node-telegram-bot-api"
import axios from "axios"
import { stringify } from "csv-stringify/sync"
import dotenv from "dotenv"
import http from "http"

dotenv.config()

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: true,
  onlyFirstMatch: true,
  request: {
    retryAfter: 5000,
  },
})

const server = http.createServer((req, res) => {
  res.writeHead(200)
  res.end("Health check passed")
})

server.listen(8000, () => {
  console.log("Health check server running on port 8000")
})

bot.onText(/\/cabal/, async (msg) => {
  const chatId = msg.chat.id
  bot.sendMessage(chatId, "Please enter 1-5 Solana token addresses, separated by spaces:")

  bot.once("text", async (tokenMsg) => {
    const addresses = tokenMsg.text.split(" ")
    if (addresses.length < 1 || addresses.length > 5) {
      bot.sendMessage(chatId, "Please enter between 1 and 5 token addresses.")
      return
    }

    try {
      const result = await queryDune(addresses)
      if (result.length === 0) {
        bot.sendMessage(chatId, "No results found for the given addresses.")
        return
      }
      const csv = stringify(result, { header: true })

      bot.sendDocument(chatId, Buffer.from(csv), {
        filename: "cabal_results.csv",
        caption: "Here are your Cabal results:",
      })
    } catch (error) {
      bot.sendMessage(chatId, `Error: ${error.message}`)
      console.error("Dune API Error:", error)
    }
  })
})

async function queryDune(addresses, retries = 3, timeout = 120000) {
  const params = {}
  addresses.forEach((address, index) => {
    params[`Token_${index + 1}`] = address
  })

  const startTime = Date.now()

  try {
    console.log("Sending request to Dune API with params:", JSON.stringify(params))
    const response = await axios.post(
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

    console.log("Dune API response:", JSON.stringify(response.data))

    if (response.data.state === "QUERY_STATE_COMPLETED") {
      return response.data.result.rows
    } else if (response.data.state === "QUERY_STATE_PENDING" || response.data.state === "QUERY_STATE_EXECUTING") {
      if (Date.now() - startTime > timeout) {
        throw new Error("Query execution timed out. Please try again later.")
      }
      if (retries > 0) {
        console.log(
          `Query is ${response.data.state.toLowerCase()}. Retrying in 10 seconds... (${retries} retries left)`,
        )
        await new Promise((resolve) => setTimeout(resolve, 10000))
        return queryDune(addresses, retries - 1, timeout - (Date.now() - startTime))
      } else {
        throw new Error("Query execution timed out. Please try again later.")
      }
    } else {
      throw new Error(`Unexpected query state: ${response.data.state}`)
    }
  } catch (error) {
    console.error("Dune API Error:", error.response ? JSON.stringify(error.response.data) : error.message)
    if (retries > 0 && Date.now() - startTime <= timeout) {
      console.log(`Error occurred. Retrying in 5 seconds... (${retries} retries left)`)
      await new Promise((resolve) => setTimeout(resolve, 5000))
      return queryDune(addresses, retries - 1, timeout - (Date.now() - startTime))
    }
    throw new Error("Failed to execute Dune query after multiple attempts. Please try again later.")
  }
}

bot.on("polling_error", (error) => {
  console.log("Polling error:", error.message)
  if (error.code === "ETELEGRAM" && error.message.includes("Conflict")) {
    setTimeout(() => {
      bot.startPolling()
    }, 10000)
  }
})

console.log("Cabal bot is running...")

