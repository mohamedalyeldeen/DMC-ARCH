// 1. إعداد مكدس التراجع (Undo Stack) والحد الأقصى
const undoStack = [];
const MAX_UNDO_LIMIT = 10;

// 2. دالة لالتقاط حالة اللوحة الحالية (Snapshot) قبل أي تعديل
function captureSnapshot() {
    // نفترض أن 'allTasks' هي المصفوفة التي تحتوي على المهام الحالية في الـ app.js الخاص بك
    if (typeof allTasks !== 'undefined') {
        // نأخذ نسخة عميقة (Deep Copy) حتى لا تتأثر بالـ References اللاحقة
        const snapshot = JSON.parse(JSON.stringify(allTasks));
        
        undoStack.push(snapshot);
        
        // الحفاظ على حجم المكدس حتى لا يستهلك ذاكرة المتصفح
        if (undoStack.length > MAX_UNDO_LIMIT) {
            undoStack.shift(); // حذف أقدم لقطة
        }
        
        updateUndoButtonState();
    }
}

// 3. تحديث حالة الزر (تفعيله أو تعطيله)
function updateUndoButtonState() {
    const undoBtn = document.getElementById('undo-btn');
    if (undoBtn) {
        undoBtn.disabled = undoStack.length === 0;
    }
}

// 4. دالة استدعاء التراجع (Trigger Undo) عند الضغط على الزر
async function triggerUndo() {
    if (undoStack.length === 0) return;
    
    // سحب آخر لقطة محفوظة
    const previousState = undoStack.pop();
    
    try {
        // إرسال اللقطة المستعادة للسيرفر ليقوم بتحديث قاعدة البيانات / Google Sheets دفعة واحدة
        const response = await fetch('/api/tasks/restore-snapshot', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ tasks: previousState })
        });
        
        if (response.ok) {
            // تحديث المصفوفة المحلية وإعادة رندرة اللوحة
            allTasks = previousState;
            renderBoard(); // افترض أن هذه هي دالة تحديث الواجهة لديك
            updateUndoButtonState();
            console.log("تم التراجع بنجاح واعادة الحالة السابقة!");
        } else {
            alert("حدث خطأ أثناء محاولة التراجع على السيرفر.");
        }
    } catch (error) {
        console.error("Undo failed:", error);
    }
}

// ====================================================
// 5. دمج التقاط اللقطات (Integration) مع أحداث اللوحة
// قم باستدعاء ()captureSnapshot مباشرة *قبل* إرسال أي طلب تعديل للسيرفر:
// ====================================================

// مثال عند مسح مهمة:
function deleteTask(taskId) {
    captureSnapshot(); // التقاط الحالة قبل المسح الفعلي
    // ... كود المسح وإرسال الـ API الحالي الخاص بك ...
}

// مثال عند تعديل مهمة (Edit):
function updateTask(taskId, updatedData) {
    captureSnapshot(); // التقاط الحالة قبل التعديل
    // ... كود التعديل وإرسال الـ API ...
}

// مثال عند سحب وإفلات مهمة (Move/Drag):
function moveTask(taskId, newStatus) {
    captureSnapshot(); // التقاط الحالة قبل النقل
    // ... كود النقل وإرسال الـ API ...
}

// مثال عند تكرار مهمة (Duplicate):
function duplicateTask(taskId) {
    captureSnapshot(); // التقاط الحالة قبل التكرار
    // ... كود التكرار وإرسال الـ API ...
}

// مثال عند إنشاء مهمة جديدة (Create):
function createTask(taskData) {
    captureSnapshot(); // التقاط الحالة قبل الإضافة
    // ... كود الإضافة وإرسال الـ API ...
}