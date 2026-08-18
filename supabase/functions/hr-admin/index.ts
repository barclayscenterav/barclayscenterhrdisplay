import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* =========================
   ENVIRONMENT VARIABLES
========================= */

const SUPABASE_URL =
  Deno.env.get("SUPABASE_URL") || "";

const HR_ADMIN_CODE =
  Deno.env.get("HR_ADMIN_CODE") || "";

function getSupabaseAdminKey(){

  const legacyServiceRoleKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if(legacyServiceRoleKey){
    return legacyServiceRoleKey;
  }

  const secretKeysRaw =
    Deno.env.get("SUPABASE_SECRET_KEYS");

  if(secretKeysRaw){

    try{

      const parsed =
        JSON.parse(secretKeysRaw);

      if(parsed.default){
        return parsed.default;
      }

      const firstKey =
        Object.values(parsed)[0];

      if(typeof firstKey === "string"){
        return firstKey;
      }

    }catch(_error){

      return "";
    }
  }

  return "";
}

const SUPABASE_ADMIN_KEY =
  getSupabaseAdminKey();

/* =========================
   SETTINGS
========================= */

const BUCKET_NAME =
  "hr-content";

const MAX_FILE_SIZE_BYTES =
  100 * 1024 * 1024;

const ALLOWED_FILE_TYPES =
  new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "video/mp4",
    "application/pdf"
  ]);

/* =========================
   CORS
========================= */

const corsHeaders = {
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":"POST, OPTIONS"
};

/* =========================
   SUPABASE ADMIN CLIENT
========================= */

const supabaseAdmin =
  createClient(
    SUPABASE_URL,
    SUPABASE_ADMIN_KEY,
    {
      auth:{
        persistSession:false,
        autoRefreshToken:false
      }
    }
  );

/* =========================
   RESPONSE HELPERS
========================= */

function jsonResponse(body:unknown,status = 200){

  return new Response(
    JSON.stringify(body),
    {
      status,
      headers:{
        ...corsHeaders,
        "Content-Type":"application/json"
      }
    }
  );
}

function safeString(value:unknown){

  if(typeof value !== "string"){
    return "";
  }

  return value.trim();
}

function safeNumber(value:unknown,fallback:number){

  const num =
    Number(value);

  if(Number.isNaN(num)){
    return fallback;
  }

  return num;
}

function checkAdminCode(code:string){

  return Boolean(HR_ADMIN_CODE) &&
    code === HR_ADMIN_CODE;
}

function makeSafeFileName(name:string){

  return name
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]/g,"-")
    .replace(/-+/g,"-")
    .replace(/^-|-$/g,"");
}

function getExtensionFromFileName(name:string){

  const parts =
    name.split(".");

  if(parts.length < 2){
    return "";
  }

  return parts.pop() || "";
}

/* =========================
   DATABASE HELPERS
========================= */

async function getNextSortOrder(){

  const { data,error } =
    await supabaseAdmin
      .from("playlist_items")
      .select("sort_order")
      .order(
        "sort_order",
        {
          ascending:false
        }
      )
      .limit(1)
      .maybeSingle();

  if(error){
    throw error;
  }

  if(!data){
    return 1;
  }

  return Number(data.sort_order || 0) + 1;
}

async function listItems(){

  const { data,error } =
    await supabaseAdmin
      .from("playlist_items")
      .select("*")
      .order(
        "sort_order",
        {
          ascending:true
        }
      );

  if(error){
    throw error;
  }

  return data || [];
}

/* =========================
   ACTION: UPLOAD
========================= */

async function uploadItem(formData:FormData){

  const file =
    formData.get("file");

  if(!(file instanceof File)){

    return jsonResponse(
      {
        error:"No file was uploaded."
      },
      400
    );
  }

  if(file.size > MAX_FILE_SIZE_BYTES){

    return jsonResponse(
      {
        error:"File is too large. Max size is 100 MB."
      },
      400
    );
  }

  if(!ALLOWED_FILE_TYPES.has(file.type)){

    return jsonResponse(
      {
        error:"Unsupported file type. Allowed files are PNG, JPG, WEBP, GIF, MP4, and PDF."
      },
      400
    );
  }

  const title =
    safeString(
      formData.get("title")
    );

  const durationSeconds =
    Math.max(
      1,
      Math.round(
        safeNumber(
          formData.get("durationSeconds"),
          10
        )
      )
    );

  const originalName =
    makeSafeFileName(
      file.name || "upload"
    );

  const extension =
    getExtensionFromFileName(
      originalName
    );

  const filePath =
    extension
      ? `uploads/${crypto.randomUUID()}.${extension}`
      : `uploads/${crypto.randomUUID()}`;

  const uploadResult =
    await supabaseAdmin
      .storage
      .from(BUCKET_NAME)
      .upload(
        filePath,
        file,
        {
          contentType:file.type,
          upsert:false
        }
      );

  if(uploadResult.error){

    return jsonResponse(
      {
        error:uploadResult.error.message
      },
      500
    );
  }

  const publicUrlResult =
    supabaseAdmin
      .storage
      .from(BUCKET_NAME)
      .getPublicUrl(filePath);

  const publicUrl =
    publicUrlResult.data.publicUrl;

  const nextSortOrder =
    await getNextSortOrder();

  const insertResult =
    await supabaseAdmin
      .from("playlist_items")
      .insert({
        title:title || originalName,
        file_path:filePath,
        public_url:publicUrl,
        file_type:file.type,
        duration_seconds:durationSeconds,
        sort_order:nextSortOrder,
        is_active:true
      })
      .select("*")
      .single();

  if(insertResult.error){

    await supabaseAdmin
      .storage
      .from(BUCKET_NAME)
      .remove([
        filePath
      ]);

    return jsonResponse(
      {
        error:insertResult.error.message
      },
      500
    );
  }

  return jsonResponse({
    item:insertResult.data
  });
}

/* =========================
   ACTION: UPDATE ITEM
========================= */

async function updateItem(body:any){

  const id =
    safeString(body.id);

  if(!id){

    return jsonResponse(
      {
        error:"Missing item ID."
      },
      400
    );
  }

  const updates:any = {
    updated_at:new Date().toISOString()
  };

  if("title" in body){

    updates.title =
      safeString(body.title);
  }

  if("durationSeconds" in body){

    updates.duration_seconds =
      Math.max(
        1,
        Math.round(
          safeNumber(
            body.durationSeconds,
            10
          )
        )
      );
  }

  if("isActive" in body){

    updates.is_active =
      Boolean(body.isActive);
  }

  const { data,error } =
    await supabaseAdmin
      .from("playlist_items")
      .update(updates)
      .eq("id",id)
      .select("*")
      .single();

  if(error){

    return jsonResponse(
      {
        error:error.message
      },
      500
    );
  }

  return jsonResponse({
    item:data
  });
}

/* =========================
   ACTION: DELETE ITEM
========================= */

async function deleteItem(body:any){

  const id =
    safeString(body.id);

  if(!id){

    return jsonResponse(
      {
        error:"Missing item ID."
      },
      400
    );
  }

  const itemResult =
    await supabaseAdmin
      .from("playlist_items")
      .select("*")
      .eq("id",id)
      .single();

  if(itemResult.error){

    return jsonResponse(
      {
        error:itemResult.error.message
      },
      500
    );
  }

  const item =
    itemResult.data;

  await supabaseAdmin
    .storage
    .from(BUCKET_NAME)
    .remove([
      item.file_path
    ]);

  const deleteResult =
    await supabaseAdmin
      .from("playlist_items")
      .delete()
      .eq("id",id);

  if(deleteResult.error){

    return jsonResponse(
      {
        error:deleteResult.error.message
      },
      500
    );
  }

  return jsonResponse({
    success:true
  });
}

/* =========================
   ACTION: REORDER
========================= */

async function reorderItems(body:any){

  const order =
    Array.isArray(body.order)
      ? body.order
      : [];

  if(!order.length){

    return jsonResponse(
      {
        error:"No playlist order was provided."
      },
      400
    );
  }

  for(let i = 0; i < order.length; i++){

    const id =
      safeString(order[i]);

    if(!id){
      continue;
    }

    const { error } =
      await supabaseAdmin
        .from("playlist_items")
        .update({
          sort_order:i + 1,
          updated_at:new Date().toISOString()
        })
        .eq("id",id);

    if(error){

      return jsonResponse(
        {
          error:error.message
        },
        500
      );
    }
  }

  const items =
    await listItems();

  return jsonResponse({
    items
  });
}

/* =========================
   MAIN REQUEST HANDLER
========================= */

Deno.serve(async (req) => {

  if(req.method === "OPTIONS"){

    return new Response(
      "ok",
      {
        headers:corsHeaders
      }
    );
  }

  if(req.method !== "POST"){

    return jsonResponse(
      {
        error:"Method not allowed."
      },
      405
    );
  }

  if(!SUPABASE_URL || !SUPABASE_ADMIN_KEY){

    return jsonResponse(
      {
        error:"Supabase environment variables are missing."
      },
      500
    );
  }

  try{

    const contentType =
      req.headers.get("content-type") || "";

    if(contentType.includes("multipart/form-data")){

      const formData =
        await req.formData();

      const action =
        safeString(
          formData.get("action")
        );

      const adminCode =
        safeString(
          formData.get("adminCode")
        );

      if(!checkAdminCode(adminCode)){

        return jsonResponse(
          {
            error:"Invalid admin code."
          },
          401
        );
      }

      if(action === "upload"){

        return await uploadItem(
          formData
        );
      }

      return jsonResponse(
        {
          error:"Unknown upload action."
        },
        400
      );
    }

    const body =
      await req.json();

    const action =
      safeString(body.action);

    const adminCode =
      safeString(body.adminCode);

    if(!checkAdminCode(adminCode)){

      return jsonResponse(
        {
          error:"Invalid admin code."
        },
        401
      );
    }

    if(action === "list"){

      const items =
        await listItems();

      return jsonResponse({
        items
      });
    }

    if(action === "update"){

      return await updateItem(
        body
      );
    }

    if(action === "delete"){

      return await deleteItem(
        body
      );
    }

    if(action === "reorder"){

      return await reorderItems(
        body
      );
    }

    return jsonResponse(
      {
        error:"Unknown action."
      },
      400
    );

  }catch(error){

    const message =
      error instanceof Error
        ? error.message
        : "Unexpected server error.";

    return jsonResponse(
      {
        error:message
      },
      500
    );
  }
});
