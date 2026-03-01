import { generateText, Output, tool, type ModelMessage } from "ai"
import { z } from "zod"
import { Sandbox } from "modal"
import { openai } from "@ai-sdk/openai"

interface ToolContext {
    sandbox: Sandbox
    sandboxId?: string
    workdir?: string
}
const timeoutMs = 10000
const codebaseWorkDir = "/app"

async function catFile({ path }: { path: string }, { sandbox, workdir = codebaseWorkDir }: ToolContext) {
    try {
        const command = await sandbox.exec(["cat", path], { workdir, timeoutMs })
        const [stdout, stderr] = await Promise.all([command.stdout.readText(), command.stderr.readText()])
        return [stdout, stderr]
    } catch (error) {
        console.error(error)
        throw error
    }
}

async function createFileBash({ path, prompt }: { path: string, prompt: string }, { sandbox, workdir = codebaseWorkDir, messages: messageHistory }: ToolContext & { messages: ModelMessage[] }) {
    const messages = [...messageHistory, userModelMessageGenerateText({ prompt })]
    const { output: { content } } = await generateText({
        messages, model: openai("gpt-5.3-codex"), output: Output.object({
            schema: z.object({
                content: z.string().describe("the content of the file to create, only the relevant code, no other text"),
            }),
        })
    })
    const delimiter = "EOFMARKER_" + Math.random().toString(36).slice(2)
    const quotedPath = "'" + path.replace(/'/g, "'\\''") + "'"
    const script = `mkdir -p "$(dirname -- ${quotedPath})" && cat <<'${delimiter}' > ${quotedPath}
${content}
${delimiter}`;
    const command = await sandbox.exec(["bash", "-lc", script], { workdir, timeoutMs })
    const [stdout, stderr] = await Promise.all([command.stdout.readText(), command.stderr.readText()])
    return [stdout, stderr]
}

const userModelMessageGenerateText = ({ prompt }: { prompt: string }): ModelMessage => {
    return {
        role: "user",
        content: [
            {
                type: "text",
                text: prompt
            }
        ]
    }
}

const listFiles = ({ sandbox, workdir = codebaseWorkDir }: ToolContext) => {
    return tool({
        description: "lists files in a relative path, using \`ls -l <path>\` under the hood",
        inputSchema: z.object({
            path: z.string().describe(`the relative path to the directory to list files from`),
        }),
        execute: async ({ path }) => {
            const command = await sandbox.exec(["ls", "-l", path], { workdir, timeoutMs })
            const [stdout, stderr] = await Promise.all([command.stdout.readText(), command.stderr.readText()])
            return `
            stdout: ${stdout}
            stderr: ${stderr ? stderr : "no errors"}
            `
        }
    })
}

const readFile = ({ sandbox, workdir = codebaseWorkDir }: ToolContext) => {
    return tool({
        description: "reads a file in a relative path, using \`cat <path>\` under the hood",
        inputSchema: z.object({
            path: z.string().describe(`the relative path to the file to read`),
        }),
        execute: async ({ path }) => {
            const [stdout, stderr] = await catFile({ path }, { sandbox, workdir })
            return `
            stdout: ${stdout}
            stderr: ${stderr ? stderr : "no errors"}
            `
        }
    })
}

const createNewFile = ({ sandbox, workdir = codebaseWorkDir }: ToolContext) => {
    return tool({
        description: "creates a new file in a relative path",
        inputSchema: z.object({
            path: z.string().describe(`the relative path to the file to create. For example: "src/components/Button.tsx"`),
            prompt: z.string().describe(`a prompt to describe the file to create`),
        }),
        execute: async ({ path, prompt }, { messages }) => {
            const [stdout, stderr] = await createFileBash({ path, prompt }, { sandbox, workdir, messages })
            return `
            stdout: ${stdout}
            stderr: ${stderr ? stderr : "no errors"}
            `
        }
    })
}

const editFile = ({ sandbox, workdir = codebaseWorkDir }: ToolContext) => {
    return tool({
        description: "edits a file in a relative path",
        inputSchema: z.object({
            path: z.string().describe(`the relative path to the file to edit`),
            prompt: z.string().describe(`a prompt to describe the changes to make`),
        }),
        execute: async ({ path, prompt }, { messages: messageHistory }) => {
            const [currentFileContent, catFileError] = await catFile({ path }, { sandbox, workdir })
            if (catFileError) {
                throw new Error(`Error reading file: ${catFileError}`)
            }
            const updateFilePrompt = `
            Current file content:
            \`\`\`
            ${currentFileContent}
            \`\`\`
            Edit the file based on the following prompt:
            \`\`\`
            ${prompt}
            \`\`\`
            Do not change other details apart from the prompt.
            `
            const [stdout, stderr] = await createFileBash({ path, prompt: updateFilePrompt }, { sandbox, workdir, messages: messageHistory })
            return `
            stdout: ${stdout}
            stderr: ${stderr ? stderr : "no errors"}
            `
        }
    })
}

const ignoreDirs = [
    "node_modules",
    "dist",
    ".next",
    "database",
]


const grep = ({ sandbox, workdir = codebaseWorkDir }: ToolContext) => {
    return tool({
        description: "searches for files with content matching the given pattern recursively in the working directory",
        inputSchema: z.object({
            pattern: z.string().describe(`the pattern to search for`),
        }),
        execute: async ({ pattern }) => {
            const excludeFlags = ignoreDirs.flatMap(dir => ["--exclude-dir", dir])
            const command = await sandbox.exec(["grep", "-ri", ...excludeFlags, pattern, "."], { workdir, timeoutMs })
            const [stdout, stderr] = await Promise.all([command.stdout.readText(), command.stderr.readText()])
            return `
            stdout: ${stdout}
            stderr: ${stderr ? stderr : "no errors"}
            `
        }
    })
}



export { listFiles, readFile, editFile, createNewFile, grep }
