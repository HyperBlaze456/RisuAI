import {
    getDatabase,
    type Chat,
    type character,
    type groupChat,
} from "src/ts/storage/database.svelte";
import type { OpenAIChat } from "../index.svelte";
import type { ChatTokenizer } from "src/ts/tokenizer";
import { requestChatData } from "../request";
import { HypaProcesser } from "./hypamemory";
import { globalFetch } from "src/ts/globalApi.svelte";
import { runSummarizer } from "../transformers";
import { parseChatML } from "src/ts/parser.svelte";

export interface HypaV2Data {
    lastMainChunkId: number; // can be removed, but exists to more readability of the code.
    mainChunks: { // summary itself
        id: number;
        text: string;
        chatMemos: Set<string>; // UUIDs of summarized chats
        lastChatMemo: string;
    }[];
    chunks: { // split mainChunks for retrieval or something. Although quite uncomfortable logic, so maybe I will delete it soon or later.
        mainChunkID: number;
        text:string;
    }[];
}

async function summary(
    stringlizedChat: string
): Promise<{ success: boolean; data: string }> {
    const db = getDatabase();
    console.log("Summarizing");

    if (db.supaModelType === "distilbart") {
        try {
            const sum = await runSummarizer(stringlizedChat);
            return { success: true, data: sum };
        } catch (error) {
            return {
                success: false,
                data: "SupaMemory: Summarizer: " + `${error}`,
            };
        }
    }

    const supaPrompt =
        db.supaMemoryPrompt === ""
            ? "[Summarize the ongoing role story, It must also remove redundancy and unnecessary text and content from the output.]\n"
            : db.supaMemoryPrompt;
    let result = "";

    if (db.supaModelType !== "subModel") {
        const promptbody = stringlizedChat + "\n\n" + supaPrompt + "\n\nOutput:";

        const da = await globalFetch("https://api.openai.com/v1/completions", {
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + db.supaMemoryKey,
            },
            method: "POST",
            body: {
                model:
                    db.supaModelType === "curie"
                        ? "text-curie-001"
                        : db.supaModelType === "instruct35"
                            ? "gpt-3.5-turbo-instruct"
                            : "text-davinci-003",
                prompt: promptbody,
                max_tokens: 600,
                temperature: 0,
            },
        });
        console.log("Using openAI instruct 3.5 for SupaMemory");

        try {
            if (!da.ok) {
                return {
                    success: false,
                    data: "SupaMemory: HTTP: " + JSON.stringify(da),
                };
            }

            result = (await da.data)?.choices[0]?.text?.trim();

            if (!result) {
                return {
                    success: false,
                    data: "SupaMemory: HTTP: " + JSON.stringify(da),
                };
            }

            return { success: true, data: result };
        } catch (error) {
            return {
                success: false,
                data: "SupaMemory: HTTP: " + error,
            };
        }
    } else {
        let parsedPrompt = parseChatML(
            supaPrompt.replaceAll("{{slot}}", stringlizedChat)
        );

        const promptbody: OpenAIChat[] = parsedPrompt ?? [
            {
                role: "user",
                content: stringlizedChat,
            },
            {
                role: "system",
                content: supaPrompt,
            },
        ];
        console.log(
            "Using submodel: ",
            db.subModel,
            "for supaMemory model"
        );
        const da = await requestChatData(
            {
                formated: promptbody,
                bias: {},
                useStreaming: false,
                noMultiGen: true,
            },
            "memory"
        );
        if (
            da.type === "fail" ||
            da.type === "streaming" ||
            da.type === "multiline"
        ) {
            return {
                success: false,
                data: "SupaMemory: HTTP: " + da.result,
            };
        }
        result = da.result;
    }
    return { success: true, data: result };
} // No, I am not going to touch any http API calls.

function isSubset<T>(subset: Set<T>, superset: Set<T>): boolean { // simple helper function. Check if subset IS a subset of superset given.
    for (const item of subset) {
        if (!superset.has(item)) {
            return false;
        }
    }
    return true;
}

function cleanInvalidChunks(
    chats: OpenAIChat[],
    data: HypaV2Data,
): void {
    const currentChatMemos = new Set(chats.map((chat) => chat.memo)); // if chunk's memo set is not subset of this, the chunk's content -> delete

    // mainChunks filtering
    data.mainChunks = data.mainChunks.filter((mainChunk) => {
        return isSubset(mainChunk.chatMemos, currentChatMemos);
    });

    // chunk filtering based on mainChunk's id
    const validMainChunkIds = new Set(data.mainChunks.map((mainChunk) => mainChunk.id));
    data.chunks = data.chunks.filter((chunk) =>
        validMainChunkIds.has(chunk.mainChunkID)
    );
    // Update lastMainChunkId
    if (data.mainChunks.length > 0) {
        data.lastMainChunkId = data.mainChunks[data.mainChunks.length - 1].id;
    } else {
        data.lastMainChunkId = 0;
    }
    console.log("Cleaned data state in cleanInvalidChunks(): ", data)
}

export async function regenerateSummary(
    chats: OpenAIChat[],
    data: HypaV2Data,
    mainChunkIndex: number
) : Promise<void> {
    const targetMainChunk = data.mainChunks[mainChunkIndex];
    
}
export async function hypaMemoryV2(
    chats: OpenAIChat[],
    currentTokens: number,
    maxContextTokens: number,
    room: Chat,
    char: character | groupChat,
    tokenizer: ChatTokenizer
): Promise<{
    currentTokens: number;
    chats: OpenAIChat[];
    error?: string;
    memory?: HypaV2Data;
}> {
    const db = getDatabase();
    const data: HypaV2Data = room.hypaV2Data ?? {
        lastMainChunkId: 0,
        chunks: [],
        mainChunks: []
    };

    // Clean invalid HypaV2 data
    cleanInvalidChunks(chats, data);

    let allocatedTokens = db.hypaAllocatedTokens;
    let chunkSize = db.hypaChunkSize;
    currentTokens += allocatedTokens + chats.length * 4; // ChatML token counting from official openai documentation
    let mainPrompt = "";
    const lastTwoChats = chats.slice(-2);
    let summarizationFailures = 0;
    const maxSummarizationFailures = 3;

    // Find the index to start summarizing from
    let idx = 0;
    if (data.mainChunks.length > 0) {
        const lastMainChunk = data.mainChunks[data.mainChunks.length - 1];
        const lastChatMemo = lastMainChunk.lastChatMemo;
        const lastChatIndex = chats.findIndex(chat => chat.memo === lastChatMemo);
        if (lastChatIndex !== -1) {
            idx = lastChatIndex + 1;
        }
    }
    // Starting chat index of new mainChunk to be generated

    // Token management loop(summarization happens)
    while (currentTokens >= maxContextTokens) {
        console.log("The current Token exceeded maxContextTokens. Current tokens: ", currentTokens, "\nMax Context Tokens: ", maxContextTokens)
        const halfData: OpenAIChat[] = [];
        let halfDataTokens = 0;
    
        // Log the start index of summarization
        const startIdx = idx;
    
        // Accumulate chats to summarize
        while (
            halfDataTokens < chunkSize &&
            idx < chats.length - 2 // Ensure the latest two chats are not added to summarization.
        ) {
            const chat = chats[idx];
            idx++;
            halfDataTokens += await tokenizer.tokenizeChat(chat);
            halfData.push(chat);
        }
    
        // Log the end index of summarization
        const endIdx = idx - 1; // Adjust as the last increment may exceed the range
    
        console.log(
            `Summarizing chats from index ${startIdx} to ${endIdx}.`
        );
    
        if (halfData.length === 0) break;
    
        const stringlizedChat = halfData
            .map((e) => `${e.role}: ${e.content}`)
            .join("\n");
        const summaryData = await summary(stringlizedChat);
    
        if (!summaryData.success) {
            summarizationFailures++;
            if (summarizationFailures >= maxSummarizationFailures) {
                return {
                    currentTokens: currentTokens,
                    chats: chats,
                    error:
                        "Summarization failed multiple times. Aborting to prevent infinite loop.",
                };
            }
            continue;
        }
    
        summarizationFailures = 0; // Reset failure counter on success
    
        const summaryDataToken = await tokenizer.tokenizeChat({
            role: "system",
            content: summaryData.data,
        });
        mainPrompt += `\n\n${summaryData.data}`;
        currentTokens -= halfDataTokens;
        allocatedTokens -= summaryDataToken;
    
        // Update lastMainChunkId and create a new mainChunk
        data.lastMainChunkId++;
        const newMainChunkId = data.lastMainChunkId;
    
        const chatMemos = new Set(halfData.map((chat) => chat.memo));
        const lastChatMemo = halfData[halfData.length - 1].memo;
    
        data.mainChunks.push({
            id: newMainChunkId,
            text: summaryData.data,
            chatMemos: chatMemos,
            lastChatMemo: lastChatMemo,
        });
    
        // Split the summary into chunks
        const splitted = summaryData.data
            .split("\n\n")
            .map((e) => e.trim())
            .filter((e) => e.length > 0);
    
        // Update chunks with the new summary
        data.chunks.push(
            ...splitted.map((e) => ({
                mainChunkID: newMainChunkId,
                text: e,
            }))
        );
    }

    // Construct the mainPrompt from mainChunks
    mainPrompt = "";
    let mainPromptTokens = 0;
    for (const chunk of data.mainChunks) {
        const chunkTokens = await tokenizer.tokenizeChat({
            role: "system",
            content: chunk.text,
        });
        if (mainPromptTokens + chunkTokens > allocatedTokens / 2) break;
        mainPrompt += `\n\n${chunk.text}`;
        mainPromptTokens += chunkTokens;
    }

    // Fetch additional memory from chunks
    const processor = new HypaProcesser(db.hypaModel);
    processor.oaikey = db.supaMemoryKey;

    const searchDocumentPrefix = "search_document: ";
    const prefixLength = searchDocumentPrefix.length;

    // Add chunks to processor for similarity search
    await processor.addText(
        data.chunks
            .filter((v) => v.text.trim().length > 0)
            .map((v) => searchDocumentPrefix + v.text.trim()) // sometimes this should not be used at all. RisuAI does not support embedding model that this is meaningful, isn't it?
    );

    let scoredResults: { [key: string]: number } = {};
    for (let i = 0; i < 3; i++) { // Should parameterize this, fixed length 3 is a magic number without explanation
        const pop = chats[chats.length - i - 1];
        if (!pop) break;
        const searched = await processor.similaritySearchScored(
            `search_query: ${pop.content}`
        );
        for (const result of searched) {
            const score = result[1] / (i + 1);
            scoredResults[result[0]] = (scoredResults[result[0]] || 0) + score;
        }
    }

    const scoredArray = Object.entries(scoredResults).sort(
        (a, b) => b[1] - a[1]
    );
    let chunkResultPrompts = "";
    let chunkResultTokens = 0;
    while (
        allocatedTokens - mainPromptTokens - chunkResultTokens > 0 &&
        scoredArray.length > 0
        ) {
        const [text] = scoredArray.shift();
        const content = text.substring(prefixLength);
        const tokenized = await tokenizer.tokenizeChat({
            role: "system",
            content: content,
        });
        if (
            tokenized >
            allocatedTokens - mainPromptTokens - chunkResultTokens
        )
            break;
        chunkResultPrompts += content + "\n\n";
        chunkResultTokens += tokenized;
    }

    const fullResult = `<Past Events Summary>${mainPrompt}</Past Events Summary>\n<Past Events Details>${chunkResultPrompts}</Past Events Details>`;

    // Filter out summarized chats
    const unsummarizedChats = chats.slice(idx);

    // Insert the memory system prompt at the beginning
    unsummarizedChats.unshift({
        role: "system",
        content: fullResult,
        memo: "supaMemory",
    });

    for (const chat of lastTwoChats) {
        if (!unsummarizedChats.find((c) => c.memo === chat.memo)) {
            unsummarizedChats.push(chat);
        }
    }

    // Recalculate currentTokens
    currentTokens = await tokenizer.tokenizeChats(unsummarizedChats);

    console.log(
        "Model being used: ",
        db.hypaModel,
        db.supaModelType,
        "\nCurrent session tokens: ",
        currentTokens,
        "\nAll chats, including memory system prompt: ",
        unsummarizedChats,
        "\nMemory data, with all the chunks: ",
        data
    );

    return {
        currentTokens: currentTokens,
        chats: unsummarizedChats,
        memory: data,
    };
}