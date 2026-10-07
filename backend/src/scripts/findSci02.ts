import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function search() {
  await mongoose.connect(process.env.MONGODB_URI || '');
  console.log('Connected to MongoDB');

  const abs = await mongoose.connection.collection('answerbooks').find().toArray();
  console.log('--- ALL ANSWER BOOKS ---');
  for (const a of abs) {
    console.log({
      id: a._id.toString(),
      code: a.answerBookCode,
      studentCode: a.studentCode,
      examId: a.examId?.toString(),
      qpId: a.questionPaperId?.toString(),
      pageCount: a.pageCount,
      status: a.status,
    });
  }

  const qps = await mongoose.connection.collection('questionpapers').find().toArray();
  console.log('\n--- ALL QUESTION PAPERS ---');
  for (const q of qps) {
    console.log({
      id: q._id.toString(),
      paperSet: q.paperSet,
      totalQuestions: q.totalQuestions,
      verifiedCount: q.verifiedQuestions?.length,
      maximumMarks: q.maximumMarks,
      examId: q.examId?.toString(),
      status: q.extractionStatus,
    });
  }

  const evals = await mongoose.connection.collection('evaluations').find().toArray();
  console.log('\n--- ALL EVALUATIONS ---');
  for (const e of evals) {
    console.log({
      id: e._id.toString(),
      answerBookId: e.answerBookId?.toString(),
      status: e.status,
      totalMarks: e.totalMarks,
      totalPossibleMarks: e.totalPossibleMarks,
      qmCount: e.questionMarks?.length,
    });
  }

  await mongoose.disconnect();
}

search();
