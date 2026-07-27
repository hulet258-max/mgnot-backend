const crypto = require("crypto");
const db = require("../config/postgres");

const COLLECTION = "payment_numbers";

function clean(value, max) {
  return String(value || "").trim().slice(0, max);
}

function normalizePhone(value) {
  return clean(value, 40).replace(/[^\d+]/g, "");
}

function publicPaymentNumber(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    phone: clean(data.phone, 40),
    label: clean(data.label, 80),
    createdAt: data.createdAt || null,
  };
}

async function listPaymentNumbers() {
  const snapshot = await db.collection(COLLECTION).get();
  return snapshot.docs
    .map(publicPaymentNumber)
    .filter((entry) => entry.phone)
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

async function addPaymentNumber({ phone, label }) {
  const cleanedPhone = clean(phone, 40);
  const normalizedPhone = normalizePhone(cleanedPhone);
  if (!cleanedPhone || normalizedPhone.replace(/\D/g, "").length < 7) {
    throw Object.assign(new Error("Enter a valid payment phone number."), { status: 400 });
  }

  const existing = await listPaymentNumbers();
  if (existing.some((entry) => normalizePhone(entry.phone) === normalizedPhone)) {
    throw Object.assign(new Error("This payment phone number already exists."), { status: 409 });
  }

  const id = crypto.randomUUID();
  const paymentNumber = {
    phone: cleanedPhone,
    label: clean(label, 80),
    createdAt: new Date().toISOString(),
  };
  await db.collection(COLLECTION).doc(id).set(paymentNumber);
  return { id, ...paymentNumber };
}

async function deletePaymentNumber(id) {
  const ref = db.collection(COLLECTION).doc(String(id));
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    throw Object.assign(new Error("Payment phone number not found."), { status: 404 });
  }
  const paymentNumber = publicPaymentNumber(snapshot);
  await ref.delete();
  return paymentNumber;
}

module.exports = {
  addPaymentNumber,
  deletePaymentNumber,
  listPaymentNumbers,
  normalizePhone,
};
