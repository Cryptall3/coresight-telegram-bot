import express from "express"
import TelegramBot from "node-telegram-bot-api"
import axios from "axios"
import { stringify } from "csv-stringify/sync"
import dotenv from "dotenv"

dotenv.config()

const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS
  ? process.env.AUTHORIZED_USERS.split(",").map((id) => Number.parseInt(id.trim()))
  : []
const DUNE_POLL_INTERVAL = 2000 // 2 seconds
const DUNE_MAX_RETRIES = 10
const DUNE_TIMEOUT = 180000 // 3 minutes

const app = express()
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN)
const PORT = process.env.PORT || 8000

function isAuthorized(userId) {
  return AUTHORIZED_USERS.includes(userId)
}

app.use(express.json())

app.post(`/bot8197465764:AAFXptudEwy5un6fgF3tWwOTcnWk0q3p8Po`, (req, res) => {
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

    bot.sendMessage(chatId, "Processing your request. Please wait...")

    try {
      const result = await queryDune(addresses)
      if (result.length === 0) {
        bot.sendMessage(chatId, "No results found for the given addresses.")
      } else {
        const csv = stringify(result, { header: true })
        const buffer = Buffer.from(csv, "utf8")
        bot.sendDocument(
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
      bot.sendMessage(chatId, `Error: ${error.message}`)
      console.error("Dune API Error:", error)
    }
  })
})

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

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
  bot.setWebHook(`${process.env.WEBHOOK_URL}/bot8197465764:AAFXptudEwy5un6fgF3tWwOTcnWk0q3p8Po`)
})

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM signal received. Closing server...")
  server.close(() => {
    console.log("Server closed.")
  })
})

