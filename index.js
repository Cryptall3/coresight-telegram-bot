const TelegramBot = require("node-telegram-bot-api")
const token = process.env.TELEGRAM_BOT_TOKEN
const bot = new TelegramBot(token, { polling: true })

async function isAuthorizedUser(userId) {
  const authorizedIds = [process.env.AUTHORIZED_GROUP_ID, `-100${process.env.AUTHORIZED_GROUP_ID.replace("-", "")}`]

  for (const groupId of authorizedIds) {
    try {
      console.log(`Checking authorization for group ID: ${groupId}`)
      const chat = await bot.getChat(groupId)
      console.log(`Group info: ID: ${chat.id}, Type: ${chat.type}, Title: ${chat.title}`)

      const chatMember = await bot.getChatMember(chat.id, userId)
      console.log(`Authorization check for user ${userId} in group ${groupId}: ${chatMember.status}`)

      if (["creator", "administrator", "member"].includes(chatMember.status)) {
        return true
      }
    } catch (error) {
      console.error(`Error checking group membership for user ${userId} in group ${groupId}:`, error)
    }
  }

  console.log(`User ${userId} is not authorized in any of the checked groups.`)
  return false
}

