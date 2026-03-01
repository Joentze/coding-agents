import * as readline from "readline/promises"
import chalk from "chalk"

import { SYSTEM_PROMPT as instructions } from "./prompts/coding-agent-prompt";
import { openai } from "@ai-sdk/openai";
import { ToolLoopAgent, type ModelMessage } from "ai";
import { ModalClient, Sandbox } from "modal";
import { createNewFile, readFile, editFile, grep, listFiles } from "./tools/coding";

const modal = new ModalClient({
    tokenId: process.env.MODAL_TOKEN_ID,
    tokenSecret: process.env.MODAL_TOKEN_SECRET,
})

const app = await modal.apps.fromName("base-nitro-bun-codex-cli-app", {
    createIfMissing: true,
});
const image = modal.images.fromRegistry("joentze/nitro-bun-codex-cli-app-template:latest");



const tools = (sandbox: Sandbox) => {
    return {
        "list-files": listFiles({ sandbox }),
        "read-file": readFile({ sandbox }),
        "edit-file": editFile({ sandbox }),
        "create-new-file": createNewFile({ sandbox }),
        "grep": grep({ sandbox }),
    } as const
}



// start cli
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
})

async function main() {

    try {
        console.log(chalk.magenta("Starting Sandbox"))
        const sandbox = await modal.sandboxes.create(app, image,
            {
                workdir: "/app",
                command: ["bun", "dev", "--", "--host", "0.0.0.0"],
                encryptedPorts: [3000],
                cpu: 1,
                cpuLimit: 2,
                memoryMiB: 1024,
                memoryLimitMiB: 4096,
                blockNetwork: false,
                idleTimeoutMs: 300000, // 5 minutes
            })
        const tunnels = await sandbox.tunnels();
        const url = tunnels["3000"]?.url;
        console.log(chalk.magenta("Sandbox URL:"), url)
        console.log(chalk.magenta("Sandbox started:"))
        console.log(chalk.magentaBright(url))
        const messages: ModelMessage[] = []
        const agent = new ToolLoopAgent({
            instructions,
            model: openai("gpt-5.3-codex"),
            tools: tools(sandbox),
        })

        while (true) {
            const userInput = await rl.question(chalk.green(": "))
            if (userInput.toLowerCase() === "/exit") break
            if (!userInput.trim()) continue

            messages.push({ role: "user", content: [{ type: "text", text: userInput }] })
            const { fullStream } = await agent.stream({ messages })

            let assistantText = ""
            for await (const part of fullStream) {
                switch (part.type) {
                    case "text-delta":
                        process.stdout.write(part.text)
                        assistantText += part.text
                        break
                    case "tool-call":
                        console.log(chalk.dim(`\n[calling ${part.toolName}]`))
                        break
                    case "tool-result":
                        console.log(chalk.dim(`[${part.toolName} done]`))
                        break
                }
            }
            console.log()

            if (assistantText) {
                messages.push({ role: "assistant", content: [{ type: "text", text: assistantText }] })
            }
        }

        // exit sandbox
        sandbox.detach()
        await sandbox.terminate()
    } catch (error) {
        console.error(chalk.red("Error:"), error)
    } finally {
        console.log(chalk.magenta("Exited Sandbox"))
        console.log(chalk.magenta("Session ended"))
        rl.close()
    }
}

main()