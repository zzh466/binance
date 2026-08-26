
const X = 50.5;
const Y = 50.5;


let  VALUECOLOR ;

// const VALUECOLOR = {
//     buy: '#ffc8e6',
//     ask: '#b4dcc8',
//     buy1: '#ffafc8',
//     ask1: '#a0dcb4',
//     deficit: '#0000ff',
//     profit: '#ff0000',
//     hold: '#00ff00',
//     limit: '#EF2E2E'
// }

const BUYBACKGROUND = '#322810'
// const ASKBACKGROUND = '#103210'
const ASKBACKGROUND = '#103210'
const FONTCOLOR = '#7f7f7f'
class Chart {
    constructor(dom, width, height, step = 0.2, config ={}){
        const {
            barToBorder,
            barVolume,
            barWidth = 10,
            calcBarType,
            volumeScaleCount,
            volumeScaleHeight = 30,
            volumeScaleTick,
            volumeScaleType,
            volumeXOffset = 0,
            volumeYOffset = 0
        } = config
        this.ctx = dom.getContext('2d');
        this.rendered = false;
        this.barToBorder = barToBorder;
        this.barWidth =barWidth;
        this.volumeScaleHeight = volumeScaleHeight;
        this.volumeScaleType = volumeScaleType;
        this.volumeScaleCount =volumeScaleCount;
        this.volumeScaleTick = volumeScaleTick;
        this.volumeXOffset = volumeXOffset;
        this.volumeYOffset = volumeYOffset;
        this.width = width;
        this.height = height;
        this.step = parseFloat(step);
        this.data = [];
        this.start = 0;
        
        this.range = this.initRange();

        this.setColor();
        const decimal = (this.step.toString().split('.')[1] || []).length;
        this.decimal = decimal;
        this.placeOrder=[];  
        this.traded ={};
        this.init();
    }

    static getHeight(range, value, volumeScaleHeight){
        let start = 0;
        let before = 0;
        if(value >  range[range.length - 1]){
            return volumeScaleHeight * range.length + 30
        }
        for(let i= 0; i < range.length; i++ ){
            if(value <= range[i]){
                start = start + ((value-before) / (range[i]-before)) * volumeScaleHeight; 
                break
            }else {
                start = start + volumeScaleHeight;
                before = range[i];
            }
        }
        if(start){
            start = Math.floor(start) + 0.5
        }
        
        return start ;
    }
     init(){
        const ctx= this.ctx;
        
        this.count = Math.floor((this.width - 150) / (this.barWidth * 2) ) * 2;
        
        
        let range = this.range;
        ctx.beginPath();
        ctx.moveTo(X + 50, Y+10);
        ctx.strokeStyle = '#404040'
        ctx.lineTo(this.width - 19.5,Y+10);
        ctx.stroke();
        
        this.renderRange(range);
       
    }
    reset(){
        this.ctx.clearRect(0, 0, this.width, this.height);
        this.rendered = false;
        this.data = [];
        this.start = 0;
        this.currentPrice = undefined;
        this.args = null;
        this.buyIndex = undefined;
        this.askIndex = undefined;
        this.lowerLimitindex = undefined;
        this.UpperLimitindex = undefined;
        this.placeOrder = [];
        this.traded = {};
        this.init();
    }
    setColor(type){
        if(type){
            VALUECOLOR = {
                buy: '#ef302d',
                ask: '#0f65a1',
                buy1: '#b31529',
                ask1: '#10559a',
                deficit: '#0000ff',
                profit: '#ff0000',
                hold: '#00ff00',
                limit: '#EF2E2E',
                low: '#00ff00',
                high: "#ffff00",
                order: '#fffbf0',
                orderBuy: '#ff0000',
                orderSell: '#ff0000'
            }
        }else{
              
        
             VALUECOLOR = {
                buy: '#ffc8e6',
                ask: '#b4dcc8',
                buy1: '#ffafc8',
                ask1: '#a0dcb4',
                deficit: '#0000ff',
                profit: '#ff0000',
                hold: '#00ff00',
                limit: '#EF2E2E',
                low: '#00ff00',
                 high: "#ffff00",
                 order: 'red',
                 orderBuy: '#ff0000',
                 orderSell: '#ff0000'
            }
        }
       
        
    }
    initRange(){

        
        let {volumeScaleHeight, volumeScaleType, volumeScaleCount, volumeScaleTick, height} = this;
        let baseRange = null;
        
        switch(volumeScaleType){
            case 0:
                volumeScaleCount = Math.floor((height - 100)/volumeScaleHeight)
                break;
            case 2:
                volumeScaleCount = Math.floor((height - 100)/volumeScaleHeight)
                baseRange = [10, 20, 30, 50, 100, 200, 400, 500, 1000, 2000, 3000, 4000, 5000].slice(0, volumeScaleCount);
                break;
            case 3:
                baseRange = [10, 20, 30, 50, 100, 200, 400, 500, 1000, 2000, 3000, 4000, 5000].slice(0, volumeScaleCount);
        }
        if(!baseRange){
            baseRange = [];
            for(let i = 1; i <= volumeScaleCount; i++){
                baseRange.push(i*volumeScaleTick)
            }
        }
        return baseRange
    }
     renderRange(range){
        
        const ctx= this.ctx;
        ctx.textAlign = 'right'
        ctx.font= '12px 宋体';
        ctx.fillStyle= FONTCOLOR;
       
       
        let {volumeScaleHeight, width} = this;
        let start = 30
        const _Y = Y + volumeScaleHeight;
        ctx.save();
      
     
        range.forEach(e => {
            ctx.fillText(e.toString(), X - 10, _Y + start + 5);
            ctx.beginPath();
            ctx.strokeStyle = '#404040'
            ctx.moveTo(X, _Y + start);
            ctx.lineTo(X+ 50 , _Y + start);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(width - 30, _Y + start);
            ctx.lineTo(width - 5 , _Y + start);
            ctx.stroke();
            start = start + volumeScaleHeight;
        });
        ctx.restore()
    }
    resize( width, height){
        
        const ctx= this.ctx;
        this.width = width;
        this.height = height;
        ctx.width = width;
        ctx.height = height;
        this.range = this.initRange()
        this.init();
        
        if(!this.currentPrice){
          this.currentPrice = this.args?.AskPrice1;
        }
        this.initData(this.currentPrice);
        this.renderPrice()
    }
     initData(price){
         if(!price || price > Number.MAX_SAFE_INTEGER) return;
         
        const count = this.count / 2;
        const decimal = this.decimal;
        const data = []
        
        data.push({
            price: price.toFixed(decimal)
        })
        for(let i = 1; i <= count; i++ ){

            data.push({
                price: (price + this.step * i).toFixed(decimal)
            })
            data.unshift({
                price: (price - this.step * i).toFixed(decimal)
            })
        }
        if(this.data.length){
            this.getindex(data[data.length - 1].price);
            this.getindex(data[0].price)
            this.start = this.getindex(price, true) - count;
        }else {
            this.data = data;
        }
        
    }
    renderBakcground(){
        const ctx = this.ctx;
        const y = Y + 30;
        const _x = X + 50.5;
        const start = this.start;
        ctx.clearRect(_x-2 , y - 5 ,this.width - 30 - _x, this.height);
        const barWidth = this.barWidth;
       
        let buyIndex = this.buyIndex - start;
       
        if(buyIndex < 0) {
            buyIndex = 0;
        } 
        if( this.buyIndex === this.lowerLimitindex){
            buyIndex = buyIndex -1
        }
        let askIndex = this.askIndex - start;
        if(askIndex < 0) {
            askIndex = 0;
        } 
        
        if( this.askIndex === this.UpperLimitindex){
            askIndex = askIndex +1
        }
        
        if(askIndex  > this.count || askIndex === 0) {
            askIndex = this.count ;
        } 
      
        ctx.fillStyle = BUYBACKGROUND;
        ctx.fillRect(_x, y, buyIndex *barWidth + barWidth,this.height);
        ctx.fillStyle = ASKBACKGROUND;
        ctx.fillRect(_x + askIndex *barWidth, y, this.width- _x - askIndex *barWidth - 30 , this.height);
        for(let i = start; (i-start) <= this.count; i ++ ){
            if(!this.data[i]){
                console.log(i, JSON.parse(JSON.stringify(this.data)))
                continue;
            }
            const { price } = this.data[i];
            const  x = X + 50 + (i - start) * barWidth;
            const y = Y + 10;
            if((price * Math.pow(10, this.decimal)).toFixed()% (this.step * Math.pow(10, this.decimal + 1)) ===0){
                ctx.save();
                ctx.beginPath();
                ctx.moveTo(x, y + 20);                
                ctx.setLineDash([1, 2])
                ctx.lineTo(x, this.height);
                ctx.stroke();
                ctx.restore()
            }
            
        }

    }
    renderPrice(){
        
        const start = this.start;
        const ctx = this.ctx;
        ctx.fillStyle= FONTCOLOR;
        ctx.textAlign = 'left'
        ctx.clearRect(100 , 0 ,this.width ,Y);
        ctx.clearRect(100 , Y+10 ,this.width ,Y+6);
        const barWidth = this.barWidth;
        for(let i = start; (i-start) <= this.count; i ++ ){
            if(!this.data[i]){
                console.log(i, JSON.parse(JSON.stringify(this.data)))
                continue;
            }
            const { price } = this.data[i];
            const  x = X + 50 + (i - start) * barWidth;
            const y = Y + 10;
            if((price * Math.pow(10, this.decimal)).toFixed() % (this.step * Math.pow(10, this.decimal + 1)) ===0){
                ctx.save();
                ctx.fillText(price, x , 20);
                ctx.beginPath();
                ctx.moveTo(x, y );
                ctx.lineTo(x, y + 6);
                ctx.stroke();
                ctx.restore()
            }else{
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x, y + 3);
                ctx.stroke();
            }
             
        }
    }
    renderVolume(){
        const ctx = this.ctx;

        const y = Y + 30;
        const _x = X + 50.5;
        const buyIndex = this.buyIndex;
        const askIndex = this.askIndex;
        const barWidth = this.barWidth;
        let askX,askY, askV, buyX,buY, buyV;
        for(let i = this.start; (i-this.start)  <= this.count; i ++ ){
            if(!this.data[i]){
                console.log(i, JSON.parse(JSON.stringify(this.data)))
                continue;
            }
            const { volum, type, isone} = this.data[i];
            if(i> buyIndex && i<askIndex){
                continue
            }
            
            if(volum){
                if((type === 'buy' && i > buyIndex) || (type ==='ask' && i < askIndex)){
                    continue;
                }
                if(i=== buyIndex && type === 'buy'){
                    ctx.fillStyle= VALUECOLOR['buy1']; 
                }else if(i===askIndex && type === 'ask'){
                    ctx.fillStyle= VALUECOLOR['ask1']; 
                }else{
                    ctx.fillStyle= VALUECOLOR[type]; 
                }
               
                const  x = _x + (i-this.start) * barWidth;
                const height = Chart.getHeight(this.range, volum, this.volumeScaleHeight); 
                ctx.fillRect(x,y,barWidth -1,height);
                
                if(i === askIndex){
                    askX = x + this.volumeXOffset;
                    askY = y;
                    if(this.volumeYOffset < 0){
                        askY = askY - this.volumeYOffset
                    }
                    askV = volum;
                } else if(i === buyIndex ){
                    buyX = x + barWidth - this.volumeXOffset;
                    buY = y;
                    buyV = volum
                    if(this.volumeYOffset > 0){
                        buY = buY + this.volumeYOffset
                    }
                }
            }

        }
        
        ctx.save();
        ctx.font= '12px 宋体';
        ctx.fillStyle= FONTCOLOR;
        if(buyV){
            buyV = buyV 
            ctx.textAlign='right'
            ctx.fillText(buyV, buyX , buY + 10);

        }
        if(askV){
            ctx.textAlign='left'
            ctx.fillText(askV, askX , askY + 10);
        }
        ctx.stroke();
    }
    clearData(startPrice, endPrice){
        if(!startPrice || !endPrice) return;
        let start = this.getindex(startPrice, true);
        if(start < 0) start = 0
        let end = this.getindex(endPrice, true);
        if(end > this.data.length -1) end = this.data.length -1;
        for(let i = start; i < end; i++){
            if(!this.data[i]){
                console.log(i, JSON.parse(JSON.stringify(this.data)))
                continue;
            }
            this.data[i].volum = 0;
        }
    }
    pushData(count){
        let {price} = this.data[this.data.length-1];
        price = parseFloat(price)
        const decimal = this.decimal
        if(count < 5){
            count = 5
        }
        for(let i =1; i <= count; i++ ){
            this.data.push({
                price: (price+ i* this.step).toFixed(decimal)
            })
        }
        this.start = this.start + count;
        
    }
    unshiftData(count){
        let {price} = this.data[0];
        price = parseFloat(price)
        const decimal = this.decimal
        if(count < 5){
            count = 5
        }
        for(let i =1; i <= count; i++ ){
            this.data.unshift({
                price:(price- i* this.step).toFixed(decimal)
            })
        }
        this.start = 0;
        return count
    }
    getindex(price, pure){
        // console.log(price, pure);
        if(Math.abs(price) > Number.MAX_SAFE_INTEGER){
           return undefined
        }
        if(!price) return this.start
        let index = Math.round((price - this.data[0].price) / this.step);
        if(pure){
            return index;
        }
        let barToBorder = parseInt(this.barToBorder);

        let offset = 0;
        let rerender = false;
        
        if(index > this.data.length - barToBorder){
             offset = index - this.data.length + barToBorder;
            this.pushData(offset);
            rerender = true;
        }
        if(index < barToBorder){
            offset = barToBorder - index;
            const count = this.unshiftData(offset)
           
            rerender = true;
            index = index + count;
        }
        const start = this.start;
        if(index < start + barToBorder){
            offset =  barToBorder+start - index;
            let min = offset;
           
            this.start = start - min
            rerender = true;
        }
        if(index > start + this.count - barToBorder){
            offset = index - start- this.count+barToBorder;
            let min = offset;

            this.start = start + min;
            rerender = true;
        }
     
        if(rerender){
            this.renderPrice();
        }
      
        return index;
    }
    renderTime(time){
        const ctx = this.ctx;
        ctx.save();
        ctx.fillStyle = FONTCOLOR;
        ctx.clearRect(0,0, 50, 20);
        ctx.fillText(time, 0, 20);
        ctx.restore();
    }
    renderCurrentPirce(price, volume){
        const ctx =this.ctx;
        ctx.save();
        ctx.setLineDash([]);
        ctx.strokeStyle = FONTCOLOR;

        // console.log(volume, this.volume)
        if(this.volume < volume){
            ctx.strokeStyle = '#ffff00';
        };
        const barWidth = this.barWidth;
        const x = X + 50 + (this.getindex(price, true) - this.start) * barWidth;
     
        ctx.clearRect(0,20,this.width,10)
        ctx.beginPath();
        ctx.moveTo(x, 21);
        ctx.lineTo(x+barWidth, 21);
        ctx.lineTo(x+barWidth, 29);
        ctx.lineTo(x, 29);
        ctx.lineTo(x, 21);
        ctx.stroke()
        ctx.restore();
        this.currentPrice = price;
        this.volume=volume
    }
    renderPlaceOrder(){
        if(this.data.length===0) return;
        
        const pricearray = this.placeOrder.reduce((a, b) => {
            const status = String(b.status || '').toUpperCase();
            const price = Number(b.price) > 0 ? Number(b.price) : Number(b.stopPrice);
            const volume = Math.max(0, Number(b.origQty) - Number(b.executedQty));
            const side = String(b.side || '').toUpperCase();

            if(!['NEW', 'PARTIALLY_FILLED'].includes(status) || !Number.isFinite(price) ||
                !Number.isFinite(volume) || volume <= 0 || !['BUY', 'SELL'].includes(side)){
                return a;
            }

            const item = a.find(e => e.price === price && e.side === side)
            if(item){
                item.volume = item.volume + volume
            }else{
                a.push({
                    price,
                    volume,
                    side
                })
            }
            return a;
        },[])
        const ctx =this.ctx;
        ctx.save();
        
        const y = Y + 30 ;
        const _x = X + 50.5;
        const {barWidth, volumeScaleHeight, range} = this;
        let _volume = [0, 0];
        let visibleCount = 0;

        pricearray.forEach(({price, volume, side}) => {
            const index = this.getindex(price, true);
            const color = side === 'BUY' ? VALUECOLOR.orderBuy : VALUECOLOR.orderSell;
            const direction = side === 'BUY' ? 0 : 1;
            _volume[direction] = _volume[direction] + volume;
            if(index < this.start || index > this.start + this.count)return;
            const  x = _x + (index-this.start) * barWidth;
            const height = Math.max(4, Chart.getHeight(range, volume, volumeScaleHeight));
            
            ctx.fillStyle = color
            ctx.fillRect(x,y,barWidth -1,height);
            visibleCount += 1;

        })
        this.holdVolume = _volume;
        this.visiblePlaceOrderCount = visibleCount;
        this.totalPlaceOrderCount = pricearray.length;
        // console.log(this.placeOrder, pricearray)
        ctx.restore()
    }
    renderTradeOrder(){
        const _x = X + 50;
        const _y = Y + 17;
        const {price, direction} = this.traded;
        const {ctx , width, start, barWidth} = this;
        if(!this.data.length)return;
        ctx.clearRect(0, _y - 1 , width, 10)
        if(direction && price.length){
            ctx.save();
            const average = price.reduce((a,b)=> a + parseFloat(b), 0) / price.length;
            const index = this.getindex(average, true)- start;
            let cindex;
            if(direction === '0'){
                cindex = this.buyIndex;
                
            }else{
                cindex = this.askIndex;
            }

            cindex = cindex - start;
            let begin, end, _direction;
            if(index <= cindex){
                begin = index;
                end = cindex;
                _direction = '0';
            }else{
                begin = cindex;
                end = index;
                _direction = '1';
            };
            let color
            if(_direction === direction){
                color = VALUECOLOR.profit;
            }else{
                color = VALUECOLOR.deficit;
            }
            if(begin === end){
                color = VALUECOLOR.hold;
            }
            ctx.fillStyle = color;
            ctx.fillRect(_x + begin * barWidth, _y , (end - begin + 1) * barWidth, 7);
            ctx.fillStyle = '#fff';
            ctx.fillText(price.length, _x+cindex * barWidth + 5, _y + 8)
            ctx.restore()
        }
    }
    renderHighandLow(){
        if(this.data.length === 0) return;
        const lowindex = this.getindex(this.LowestPrice, true);
        const highindex = this.getindex(this.HighestPrice, true);
        const {start, ctx, count, barWidth, height} = this;
        let lowX = (lowindex - start) * barWidth;
        let HighX = (highindex - start) * barWidth
        if(lowindex < start || lowindex > start + count){
            lowX =  - 50;
        }
        if(highindex > start + count || highindex < start){
            HighX = this.width - X - 51
        }
        ctx.clearRect(X -1, Y + 29 ,2 , height - 10);
        ctx.clearRect( this.width - 2, Y + 29 ,2 , height - 10);
        const offset= X + 50;
        ctx.save()
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.strokeStyle = VALUECOLOR.low
        ctx.moveTo(lowX+offset, Y + 30);
        ctx.lineTo(lowX+offset,height - 10);
        ctx.stroke();
        ctx.beginPath();
        
        ctx.strokeStyle = VALUECOLOR.high
        ctx.moveTo(HighX+offset, Y + 30);
        ctx.lineTo(HighX+offset,height - 10);
        ctx.stroke();
        ctx.restore();
        this.renderLimited()
    }
    renderLimited(){
    
        const lowindex = this.lowerLimitindex
        const highindex =  this.UpperLimitindex;
   
        const offset= X + 49.5;
        const {start, ctx, count, barWidth, height} = this;
        ctx.save()
        ctx.strokeStyle = VALUECOLOR.limit;
        ctx.lineWidth = 2
        function render(index){
            if(start<=index  && index <=start+count){
                const _X = (index - start) * barWidth;
                ctx.beginPath();
                ctx.moveTo(_X+offset, Y + 30);
                ctx.lineTo(_X+offset,height - 10);
                ctx.stroke();
            }
        };
        render(lowindex);
        render(highindex);
        ctx.restore();
    }
    renderseconds(){
        const time = new Date().getMilliseconds();
        const ctx = this.ctx;
        ctx.save();
        ctx.fillStyle = FONTCOLOR;
        const width = this.width - 20
        ctx.clearRect(width,0, 20, 10);
        ctx.fillText(time, width, 10);
        ctx.restore();
    }
    render(arg){
        
        if(!arg.LastPrice){
            arg.LastPrice = arg.AskPrice1 || arg.BidPrice1
        }
        if(arg.LastPrice > Number.MAX_SAFE_INTEGER) return
        if(this.data.length === 0) {
            console.log(arg.LastPrice)
            this.initData(arg.LastPrice);
            if(!this.data.length) return
            this.renderPrice();
        }
       
        
        this.args= arg
        // this.renderTime(arg.UpdateTime)
        // console.log(arg)
        if(arg.BidPrice5  &&  arg.BidPrice5 <= Number.MAX_SAFE_INTEGER){
            this.clearData(arg.BidPrice5 , arg.BidPrice1 );
        }
        if(arg.AskPrice5  &&  arg.AskPrice5 <= Number.MAX_SAFE_INTEGER){
            this.clearData(arg.AskPrice1 , arg.AskPrice5 );
        }
        let pauseAsk, pasuseBuy;
        for(let i=5; i> 0; i--){
            let buyPirce = arg[`BidPrice${i}`];
            let buyIndex ;
            const flag = this.rendered?i> 1 : i < 5;
            
            if(buyPirce && !pasuseBuy){
                buyIndex = this.getindex(buyPirce, flag)
                const buyData = this.data[buyIndex];
                if(buyData){
                    buyData.volum = arg[`BidVolume${i}`];
                    buyData.type = 'buy';
                }                                        
            }
          
            
            const askPirce = arg[`AskPrice${i}`] ;
            let askIndex;
            if(askPirce && !pauseAsk){
                askIndex = this.getindex(askPirce, flag)
                const askData = this.data[askIndex];
                if(askData){
                    askData.volum = arg[`AskVolume${i}`];
                    askData.type = 'ask';
                }                              
            }
            
            if(i === 1) {
                if(!buyPirce || buyPirce>= Number.MAX_SAFE_INTEGER || buyPirce <= Number.MIN_SAFE_INTEGER){
                    buyIndex = askIndex 
                    pasuseBuy = true;
                }
                if(!askPirce  || askPirce>= Number.MAX_SAFE_INTEGER || askPirce <= Number.MIN_SAFE_INTEGER){
                    askIndex = buyIndex;
                    pauseAsk = true; 
                    
                }
                this.buyIndex = buyIndex;
                this.askIndex = askIndex;
                
            }
        }
        this.lowerLimitPrice = arg.LowerLimitPrice;
        this.UpperLimitPrice = arg.UpperLimitPrice;
        this.lowerLimitindex = this.getindex(arg.LowerLimitPrice, true);
        this.UpperLimitindex = this.getindex(arg.UpperLimitPrice, true);
        if(!arg.BidPrice1){
          
            this.buyIndex = this.lowerLimitindex
        }
        if(!arg.AskPrice1){
           
            this.askIndex = this.UpperLimitindex
        }
        this.LowestPrice = arg.LowestPrice;
        this.HighestPrice = arg.HighestPrice;
       
        this.renderBakcground();
        
        this.renderVolume();
        // this.renderHighandLow()
      
        
        // this.renderCurrentPirce(arg.LastPrice, arg.Volume);
        this.renderPlaceOrder();
        this.renderTradeOrder();
        this.rendered= true;
        // this.renderseconds()

     
    }
}

const elements = {
  environmentSwitch: document.querySelector("#environmentSwitch"),
  environmentSwitchStatus: document.querySelector("#environmentSwitchStatus"),
  environmentWarning: document.querySelector("#environmentWarning"),
  environment: document.querySelector("#environment"),
  tradingEnvironment: document.querySelector("#tradingEnvironment"),
  orderHistoryEnvironment: document.querySelector("#orderHistoryEnvironment"),
  tradeHistoryEnvironment: document.querySelector("#tradeHistoryEnvironment"),
  accountEnvironment: document.querySelector("#accountEnvironment"),
  credentials: document.querySelector("#credentials"),
  chartOpenOrderStatus: document.querySelector("#chartOpenOrderStatus"),
  marketStatus: document.querySelector("#marketStatus"),
  timeOffset: document.querySelector("#timeOffset"),
  depthConfig: document.querySelector("#depthConfig"),
  klineInterval: document.querySelector("#klineInterval"),
  overviewStatus: document.querySelector("#overviewStatus"),
  overviewLastPrice: document.querySelector("#overviewLastPrice"),
  overviewBookTicker: document.querySelector("#overviewBookTicker"),
  overviewAveragePrice: document.querySelector("#overviewAveragePrice"),
  overviewChange: document.querySelector("#overviewChange"),
  overviewHighLow: document.querySelector("#overviewHighLow"),
  filterRulesBody: document.querySelector("#filterRulesBody"),
  klineBody: document.querySelector("#klineBody"),
  publicTradesBody: document.querySelector("#publicTradesBody"),
  openOrdersStatus: document.querySelector("#openOrdersStatus"),
  openOrdersBody: document.querySelector("#openOrdersBody"),
  queryOrderId: document.querySelector("#queryOrderId"),
  amendOrderQty: document.querySelector("#amendOrderQty"),
  replaceOrderPrice: document.querySelector("#replaceOrderPrice"),
  queryOrderStatus: document.querySelector("#queryOrderStatus"),
  queryOrderBody: document.querySelector("#queryOrderBody"),
  chartSymbolInput: document.querySelector("#chartSymbolInput"),
  switchChartSymbolButton: document.querySelector("#switchChartSymbolButton"),
  chartSymbolSwitchStatus: document.querySelector("#chartSymbolSwitchStatus"),
  lastUpdateId: document.querySelector("#lastUpdateId"),
  receivedAt: document.querySelector("#receivedAt"),
  spread: document.querySelector("#spread"),
  bidRows: document.querySelector("#bidRows"),
  askRows: document.querySelector("#askRows"),
  side: document.querySelector("#side"),
  orderType: document.querySelector("#orderType"),
  orderSizingMode: document.querySelector("#orderSizingMode"),
  quantityOrderLabel: document.querySelector("#quantityOrderLabel"),
  quantity: document.querySelector("#quantity"),
  quoteOrderQtyLabel: document.querySelector("#quoteOrderQtyLabel"),
  quoteOrderQty: document.querySelector("#quoteOrderQty"),
  orderSizingHint: document.querySelector("#orderSizingHint"),
  price: document.querySelector("#price"),
  latestTradePriceToggle: document.querySelector("#latestTradePriceToggle"),
  latestTradePriceState: document.querySelector("#latestTradePriceState"),
  stopPrice: document.querySelector("#stopPrice"),
  trailingDelta: document.querySelector("#trailingDelta"),
  icebergQty: document.querySelector("#icebergQty"),
  orderId: document.querySelector("#orderId"),
  refreshOrderHistoryButton: document.querySelector(
    "#refreshOrderHistoryButton"
  ),
  orderHistoryStatus: document.querySelector("#orderHistoryStatus"),
  orderHistoryBody: document.querySelector("#orderHistoryBody"),
  refreshTradeHistoryButton: document.querySelector(
    "#refreshTradeHistoryButton"
  ),
  tradeHistoryStatus: document.querySelector("#tradeHistoryStatus"),
  tradeHistoryBody: document.querySelector("#tradeHistoryBody"),
  refreshAccountButton: document.querySelector("#refreshAccountButton"),
  signTradFiAgreementButton: document.querySelector(
    "#signTradFiAgreementButton"
  ),
  tradFiAgreementStatus: document.querySelector("#tradFiAgreementStatus"),
  accountStatus: document.querySelector("#accountStatus"),
  accountType: document.querySelector("#accountType"),
  accountCanTrade: document.querySelector("#accountCanTrade"),
  accountCanDeposit: document.querySelector("#accountCanDeposit"),
  accountCanWithdraw: document.querySelector("#accountCanWithdraw"),
  accountPermissions: document.querySelector("#accountPermissions"),
  accountTradeGroupId: document.querySelector("#accountTradeGroupId"),
  accountUpdateTime: document.querySelector("#accountUpdateTime"),
  accountBalancesBody: document.querySelector("#accountBalancesBody"),
  riskStatus: document.querySelector("#riskStatus"),
  riskBody: document.querySelector("#riskBody"),
  ocoSide: document.querySelector("#ocoSide"),
  ocoQuantity: document.querySelector("#ocoQuantity"),
  ocoWorkingPrice: document.querySelector("#ocoWorkingPrice"),
  ocoAbovePrice: document.querySelector("#ocoAbovePrice"),
  ocoAboveStopPrice: document.querySelector("#ocoAboveStopPrice"),
  ocoBelowPrice: document.querySelector("#ocoBelowPrice"),
  ocoBelowStopPrice: document.querySelector("#ocoBelowStopPrice"),
  orderListId: document.querySelector("#orderListId"),
  orderListsStatus: document.querySelector("#orderListsStatus"),
  orderListsBody: document.querySelector("#orderListsBody"),
  userDataStatus: document.querySelector("#userDataStatus"),
  userDataBody: document.querySelector("#userDataBody"),
  requestDuration: document.querySelector("#requestDuration"),
  output: document.querySelector("#output"),
};

let activeEnvironmentTestnet = true;
let environmentSwitchBusy = false;
let tradFiAgreementBusy = false;

function printResult(title, result) {
  const elapsedMs = Number(result?.elapsedMs);
  elements.requestDuration.textContent = Number.isFinite(elapsedMs)
    ? `端到端耗时：${elapsedMs.toFixed(3)} ms`
    : "端到端耗时：- ms";
  elements.output.textContent = `${title}\n${JSON.stringify(result, null, 2)}`;
}

function formatError(result) {
  if (result?.ok) {
    return null;
  }

  const error = result?.error || {};
  return [
    error.message || "未知错误",
    error.code !== undefined ? `code=${error.code}` : "",
    error.status !== undefined ? `HTTP=${error.status}` : "",
  ]
    .filter(Boolean)
    .join("；");
}

function requiresTradFiPerpsAgreement(result) {
  if (result?.ok) return false;
  const errorText = [
    result?.error?.message,
    result?.error?.data?.msg,
    JSON.stringify(result?.error?.data || {}),
  ]
    .filter(Boolean)
    .join(" ");
  return /sign\s+tradfi[-\s]?perps\s+agreement\s+contract\s+fapi/i.test(
    errorText
  );
}

async function signCurrentTradFiPerpsAgreement({ retryOrder = false } = {}) {
  if (tradFiAgreementBusy) return null;
  if (activeEnvironmentTestnet) {
    const result = {
      ok: false,
      error: {
        name: "EnvironmentError",
        message: "TradFi-Perps 协议签署仅适用于 Binance 正式环境。",
      },
    };
    elements.tradFiAgreementStatus.textContent = result.error.message;
    printResult("TradFi-Perps 协议签署失败", result);
    return result;
  }

  const retryDescription = retryOrder
    ? "签署成功后，程序会重试刚才被币安拒绝的原委托。"
    : "该操作只签署协议，不会创建订单。";
  if (!window.confirm(
    "即将使用当前配置的 U 本位 API Key，为其所属子账号签署 Binance " +
    `TradFi-Perps 协议。${retryDescription}\n\n` +
    "这是账户级交易协议操作，请确认你有权代表该子账号签署。是否继续？"
  )) {
    elements.tradFiAgreementStatus.textContent = "已取消签署";
    return null;
  }

  tradFiAgreementBusy = true;
  elements.signTradFiAgreementButton.disabled = true;
  elements.tradFiAgreementStatus.textContent = "正在签署…";
  try {
    const result = await window.binance.signTradFiPerpsAgreement();
    elements.tradFiAgreementStatus.textContent = result.ok
      ? "当前 U 本位子账号已成功签署 TradFi-Perps 协议"
      : formatError(result);
    printResult("TradFi-Perps 协议签署结果", result);
    return result;
  } catch (error) {
    const result = {
      ok: false,
      error: {
        name: error?.name || "Error",
        message: error?.message || "协议签署请求失败",
      },
    };
    elements.tradFiAgreementStatus.textContent = result.error.message;
    printResult("TradFi-Perps 协议签署异常", result);
    return result;
  } finally {
    tradFiAgreementBusy = false;
    elements.signTradFiAgreementButton.disabled = false;
  }
}

async function submitOrderWithTradFiAgreement(order, { testOnly = false } = {}) {
  console.log(order);
  const submit = () => testOnly
    ? window.binance.testOrder(order)
    : window.binance.placeOrder(order);
  let result = await submit();
  if (!requiresTradFiPerpsAgreement(result)) return result;

  printResult("币安要求先签署 TradFi-Perps 协议", result);
  const agreementResult = await signCurrentTradFiPerpsAgreement({
    retryOrder: true,
  });
  if (!agreementResult) return result;
  if (!agreementResult.ok) return agreementResult;

  result = await submit();
  return result;
}

function renderDepthRows(container, levels) {

  container.replaceChildren();

  for (const level of levels) {
    const row = document.createElement("tr");
    const price = document.createElement("td");
    const quantity = document.createElement("td");

    price.textContent = level.price;
    quantity.textContent = level.quantity;
    row.append(price, quantity);
    container.append(row);
  }
}

function formatOrderTime(value) {
  const timestamp = Number(value);

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return value ?? "-";
  }

  return new Date(timestamp).toLocaleString();
}

function renderOrders(orders, container = elements.orderHistoryBody) {
  container.replaceChildren();

  if (!orders.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 9;
    cell.textContent = "当前交易对没有可展示的普通订单";
    row.append(cell);
    container.append(row);
    return;
  }

  for (const order of orders) {
    const row = document.createElement("tr");
    const orderId = document.createElement("td");
    const symbol = document.createElement("td");
    const side = document.createElement("td");
    const type = document.createElement("td");
    const status = document.createElement("td");
    const price = document.createElement("td");
    const originalQuantity = document.createElement("td");
    const executedQuantity = document.createElement("td");
    const updateTime = document.createElement("td");

    orderId.className = "numeric";
    orderId.textContent = order.orderId ?? "-";
    symbol.textContent = order.symbol || "-";
    side.textContent = order.side || "-";
    type.textContent = order.type || "-";
    status.textContent = order.status || "-";
    price.textContent = order.price ?? "-";
    originalQuantity.textContent = order.origQty ?? "-";
    executedQuantity.textContent = order.executedQty ?? "-";
    updateTime.textContent = formatOrderTime(
      order.updateTime ?? order.time
    );

    row.append(
      orderId,
      symbol,
      side,
      type,
      status,
      price,
      originalQuantity,
      executedQuantity,
      updateTime
    );
    container.append(row);
  }
}

function renderTrades(trades) {
  elements.tradeHistoryBody.replaceChildren();

  if (!trades.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 11;
    cell.textContent = "当前交易对没有可展示的成交记录";
    row.append(cell);
    elements.tradeHistoryBody.append(row);
    return;
  }

  for (const trade of trades) {
    const row = document.createElement("tr");
    const tradeId = document.createElement("td");
    const orderId = document.createElement("td");
    const symbol = document.createElement("td");
    const price = document.createElement("td");
    const quantity = document.createElement("td");
    const quoteQuantity = document.createElement("td");
    const commission = document.createElement("td");
    const commissionAsset = document.createElement("td");
    const side = document.createElement("td");
    const liquidity = document.createElement("td");
    const time = document.createElement("td");

    tradeId.className = "numeric";
    orderId.className = "numeric";
    tradeId.textContent = trade.id ?? "-";
    orderId.textContent = trade.orderId ?? "-";
    symbol.textContent = trade.symbol || "-";
    price.textContent = trade.price ?? "-";
    quantity.textContent = trade.qty ?? "-";
    quoteQuantity.textContent = trade.quoteQty ?? "-";
    commission.textContent = trade.commission ?? "-";
    commissionAsset.textContent = trade.commissionAsset || "-";
    side.textContent = trade.isBuyer === true ? "买入" : "卖出";
    liquidity.textContent = trade.isMaker === true ? "Maker" : "Taker";
    time.textContent = formatOrderTime(trade.time);

    row.append(
      tradeId,
      orderId,
      symbol,
      price,
      quantity,
      quoteQuantity,
      commission,
      commissionAsset,
      side,
      liquidity,
      time
    );
    elements.tradeHistoryBody.append(row);
  }
}

function formatAccountBoolean(value) {
  if (value === true) {
    return "是";
  }

  if (value === false) {
    return "否";
  }

  return "-";
}

function renderAccountInfo(account) {
  elements.accountType.textContent = account.accountType || "-";
  elements.accountCanTrade.textContent = formatAccountBoolean(
    account.canTrade
  );
  elements.accountCanDeposit.textContent = formatAccountBoolean(
    account.canDeposit
  );
  elements.accountCanWithdraw.textContent = formatAccountBoolean(
    account.canWithdraw
  );
  elements.accountPermissions.textContent = Array.isArray(account.permissions)
    ? account.permissions.join(", ") || "-"
    : "-";
  if (Number(account.tradeGroupId) === -1) {
    elements.accountTradeGroupId.textContent = account.marketType === "futures"
      ? "-1（U 本位账户未配置交易组）"
      : "-1（未分组，跨子账号 STP 不生效）";
  } else if (account.tradeGroupId !== undefined && account.tradeGroupId !== null) {
    elements.accountTradeGroupId.textContent = String(account.tradeGroupId);
  } else {
    elements.accountTradeGroupId.textContent = "未返回";
  }
  elements.accountUpdateTime.textContent = formatOrderTime(account.updateTime);

  elements.accountBalancesBody.replaceChildren();
  const balances = (Array.isArray(account.balances) ? account.balances : []).filter(
    (balance) => Number(balance.locked) !== 0
  );

  if (!balances.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.textContent = "当前账户没有锁定余额不为 0 的资产";
    row.append(cell);
    elements.accountBalancesBody.append(row);
    return;
  }

  for (const balance of balances) {
    const row = document.createElement("tr");
    const asset = document.createElement("td");
    const free = document.createElement("td");
    const locked = document.createElement("td");

    asset.textContent = balance.asset || "-";
    free.textContent = balance.free ?? "-";
    locked.textContent = balance.locked ?? "-";
    row.append(asset, free, locked);
    elements.accountBalancesBody.append(row);
  }
}

function appendTextRow(container, values, columnCount) {
  const row = document.createElement("tr");
  for (const value of values) {
    const cell = document.createElement("td");
    cell.textContent = value ?? "-";
    row.append(cell);
  }
  if (values.length === 1 && columnCount > 1) {
    row.firstChild.colSpan = columnCount;
  }
  container.append(row);
}

function renderExchangeInfo(result) {
  elements.filterRulesBody.replaceChildren();
  const symbolInfo = result?.symbol;
  const filters = Array.isArray(symbolInfo?.filters) ? symbolInfo.filters : [];
  if (!filters.length) {
    appendTextRow(elements.filterRulesBody, ["没有可展示的交易规则"], 2);
    return;
  }
  for (const filter of filters) {
    const { filterType, ...rules } = filter;
    appendTextRow(elements.filterRulesBody, [filterType, JSON.stringify(rules)], 2);
  }
}

function renderMarketOverview(data) {
  elements.overviewLastPrice.textContent = data.price?.price ?? "-";
  elements.overviewBookTicker.textContent = `${data.bookTicker?.bidPrice ?? "-"} / ${data.bookTicker?.askPrice ?? "-"}`;
  elements.overviewAveragePrice.textContent = data.averagePrice?.label
    ? `${data.averagePrice?.price ?? "-"}（${data.averagePrice.label}）`
    : `${data.averagePrice?.price ?? "-"}（${data.averagePrice?.mins ?? "-"} 分钟）`;
  elements.overviewChange.textContent = `${data.ticker24hr?.priceChange ?? "-"} / ${data.ticker24hr?.priceChangePercent ?? "-"}%`;
  elements.overviewHighLow.textContent = `${data.ticker24hr?.highPrice ?? "-"} / ${data.ticker24hr?.lowPrice ?? "-"}`;

  elements.klineBody.replaceChildren();
  const klines = Array.isArray(data.klines) ? data.klines.slice(-20).reverse() : [];
  if (!klines.length) {
    appendTextRow(elements.klineBody, ["没有 K 线数据"], 7);
    return;
  }
  for (const kline of klines) {
    appendTextRow(elements.klineBody, [
      formatOrderTime(kline.openTime), kline.open, kline.high, kline.low,
      kline.close, kline.volume, kline.tradeCount,
    ], 7);
  }

  elements.publicTradesBody.replaceChildren();
  const recent = (data.recentTrades || []).slice(-10).reverse().map((trade) => [
    "recent", trade.id, trade.price, trade.qty, formatOrderTime(trade.time),
    trade.isBuyerMaker === true ? "是" : "否",
  ]);
  const historical = (data.historicalTrades || []).slice(-10).reverse().map((trade) => [
    "historical", trade.id, trade.price, trade.qty, formatOrderTime(trade.time),
    trade.isBuyerMaker === true ? "是" : "否",
  ]);
  const aggregate = (data.aggregateTrades || []).slice(-10).reverse().map((trade) => [
    "aggregate", trade.a, trade.p, trade.q, formatOrderTime(trade.T),
    trade.m === true ? "是" : "否",
  ]);
  const trades = [...recent, ...historical, ...aggregate];
  if (!trades.length) appendTextRow(elements.publicTradesBody, ["没有公开成交数据"], 6);
  else for (const trade of trades) appendTextRow(elements.publicTradesBody, trade, 6);
}

function renderRiskRows(rows) {
  elements.riskBody.replaceChildren();
  if (!rows.length) {
    appendTextRow(elements.riskBody, ["没有可展示的信息"], 5);
    return;
  }
  for (const row of rows) appendTextRow(elements.riskBody, row, 5);
}

function renderOrderLists(lists) {
  elements.orderListsBody.replaceChildren();
  const normalized = Array.isArray(lists) ? lists : lists ? [lists] : [];
  if (!normalized.length) {
    appendTextRow(elements.orderListsBody, ["没有组合订单记录"], 7);
    return;
  }
  for (const list of normalized) {
    appendTextRow(elements.orderListsBody, [
      list.orderListId, list.symbol, list.contingencyType,
      list.listStatusType, list.listOrderStatus,
      Array.isArray(list.orders) ? list.orders.length : "-",
      formatOrderTime(list.transactionTime),
    ], 7);
  }
}

function summarizeUserDataEvent(event) {
  if (event.e === "executionReport") {
    return `${event.S || ""} ${event.o || ""} ${event.q || ""} @ ${event.p || ""}`.trim();
  }
  if (event.e === "outboundAccountPosition") {
    return (event.B || []).map((balance) => `${balance.a}: ${balance.f}/${balance.l}`).join(", ");
  }
  if (event.e === "balanceUpdate") {
    return `余额变化 ${event.d ?? "-"}`;
  }
  return JSON.stringify(event).slice(0, 240);
}

function prependUserDataEvent(payload) {
  if (elements.userDataBody.querySelector("td[colspan]")) {
    elements.userDataBody.replaceChildren();
  }
  const event = payload.event || {};
  const row = document.createElement("tr");
  for (const value of [
    formatOrderTime(payload.receivedAt), event.e || "未知事件",
    event.s || event.a || "-", event.X || event.x || event.l || "-",
    event.i ?? "-", summarizeUserDataEvent(event),
  ]) {
    const cell = document.createElement("td");
    cell.textContent = value;
    row.append(cell);
  }
  elements.userDataBody.prepend(row);
  while (elements.userDataBody.children.length > 100) {
    elements.userDataBody.lastElementChild.remove();
  }
}

function getSelectedSymbol() {
  const symbol = elements.chartSymbolInput.value.trim().toUpperCase();
  elements.chartSymbolInput.value = symbol;
  return symbol;
}

function getMarketLabel(marketType) {
  return marketType === "futures" ? "USDⓈ-M" : "Spot";
}

function readOrderForm() {
  const type = elements.orderType.value;
  const quoteTotalMode = elements.orderSizingMode.value === "quote-total";
  const order = {
    symbol: getSelectedSymbol(),
    side: elements.side.value,
    type,
    price: elements.price.value.trim(),
    stopPrice: elements.stopPrice.value.trim(),
    trailingDelta: elements.trailingDelta.value.trim(),
    icebergQty: elements.icebergQty.value.trim(),
    timeInForce: ["LIMIT", "STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT"].includes(type) ? "GTC" : undefined,
  };
  if (quoteTotalMode) {
    order.quoteOrderQty = elements.quoteOrderQty.value.trim();
  } else {
    order.quantity = elements.quantity.value.trim();
  }
  return order;
}

function updateOrderSizingFields() {
  const quoteTotalMode = elements.orderSizingMode.value === "quote-total";
  elements.quantityOrderLabel.hidden = quoteTotalMode;
  elements.quantity.hidden = quoteTotalMode;
  elements.quoteOrderQtyLabel.hidden = !quoteTotalMode;
  elements.quoteOrderQty.hidden = !quoteTotalMode;
  elements.orderSizingHint.textContent = quoteTotalMode
    ? "总价是计价资产的名义金额（例如 USDT），不是永续保证金。" +
      "现货市价单直接按总价提交；其他订单由程序按委托价、触发价或最新成交价换算数量。"
    : "当前按交易数量下单。快捷键始终使用配置中的手数。";
}

elements.orderSizingMode.addEventListener("change", updateOrderSizingFields);
updateOrderSizingFields();

async function loadStatus() {
  const result = await window.binance.getStatus();
  const error = formatError(result);

  if (error) {
    printResult("读取状态失败", result);
    return;
  }

  const status = result.data;
  activeEnvironmentTestnet = Boolean(status.testnet);
  elements.signTradFiAgreementButton.disabled = activeEnvironmentTestnet;
  elements.tradFiAgreementStatus.textContent = activeEnvironmentTestnet
    ? "Testnet 不需要签署 TradFi-Perps 正式协议"
    : "协议按当前 U 本位 API Key 所属子账号分别签署";
  elements.environmentSwitch.checked = !activeEnvironmentTestnet;
  elements.environmentSwitchStatus.textContent = activeEnvironmentTestnet
    ? "当前：Binance Testnet"
    : "当前：Binance Production（真实资产）";
  elements.environmentWarning.classList.toggle(
    "production",
    !activeEnvironmentTestnet
  );
  elements.environmentWarning.textContent = activeEnvironmentTestnet
    ? "当前连接 Binance Testnet。输入合约后，后台自动识别 Spot 或 USDⓈ-M，并选择对应接口。"
    : "当前连接 Binance 正式环境：后台会自动选择 Spot 或 USDⓈ-M；报单和撤单会影响真实资产，请确认合约、价格和数量。";
  elements.environment.textContent = status.testnet
    ? "Binance Testnet"
    : "Binance Production";
  elements.tradingEnvironment.textContent = "按全局合约自动路由";
  elements.orderHistoryEnvironment.textContent = "按全局合约自动路由";
  elements.tradeHistoryEnvironment.textContent = "按全局合约自动路由";
  elements.accountEnvironment.textContent = "按全局合约自动路由";
  const spotCredentialsReady = Boolean(
    status.markets?.spot?.hasApiKey && status.markets?.spot?.hasApiSecret
  );
  const futuresCredentialsReady = Boolean(
    status.markets?.futures?.hasApiKey && status.markets?.futures?.hasApiSecret
  );
  elements.credentials.textContent =
    `Spot ${spotCredentialsReady ? "已配置" : "未配置"} / ` +
    `USDⓈ-M ${futuresCredentialsReady ? "已配置" : "未配置"}`;
  elements.timeOffset.textContent =
    `Spot ${status.markets?.spot?.serverTimeOffsetMs ?? 0} ms / ` +
    `USDⓈ-M ${status.markets?.futures?.serverTimeOffsetMs ?? 0} ms`;
  elements.depthConfig.textContent =
    `${status.depthSpeed} / 快照 ${status.depthSnapshotLimit} 档 / 显示 ${status.depthDisplayLevels} 档`;
}

elements.environmentSwitch.addEventListener("change", async () => {
  if (environmentSwitchBusy) return;

  const targetTestnet = !elements.environmentSwitch.checked;
  if (
    !targetTestnet &&
    !window.confirm(
      "确定切换到 Binance 正式环境吗？程序会自动选择 Spot 或 USDⓈ-M，报单和撤单会影响真实资产。"
    )
  ) {
    elements.environmentSwitch.checked = !activeEnvironmentTestnet;
    return;
  }

  environmentSwitchBusy = true;
  elements.environmentSwitch.disabled = true;
  elements.environmentSwitchStatus.textContent = targetTestnet
    ? "正在切换到 Testnet…"
    : "正在切换到正式环境…";

  let result;
  try {
    result = await window.binance.switchEnvironment(targetTestnet);
  } catch (error) {
    result = {
      ok: false,
      error: {
        name: error?.name || "Error",
        message: error?.message || "环境切换请求失败",
      },
    };
  }
  if (!result.ok) {
    elements.environmentSwitch.checked = !activeEnvironmentTestnet;
    elements.environmentSwitchStatus.textContent = "切换失败";
    elements.environmentSwitch.disabled = false;
    environmentSwitchBusy = false;
    printResult("切换 Binance 环境失败", result);
    return;
  }

  sessionStorage.setItem("binanceEnvironmentSwitchResult", JSON.stringify(result));
  window.location.reload();
});

document
  .querySelector("#syncTimeButton")
  .addEventListener("click", async () => {
    const result = await window.binance.syncTime({ symbol: getSelectedSymbol() });
    printResult("服务器时间同步", result);

    if (result.ok) {
      elements.timeOffset.textContent =
        `${getMarketLabel(result.data.marketType)} ${result.data.offsetMs} ms`;
    }
  });

document.querySelector("#pingButton").addEventListener("click", async () => {
  const result = await window.binance.ping({ symbol: getSelectedSymbol() });
  printResult("Binance 连通性测试", result);
  elements.overviewStatus.textContent = result.ok ? "连接正常" : formatError(result);
});

document.querySelector("#refreshRulesButton").addEventListener("click", async () => {
  elements.overviewStatus.textContent = "加载交易规则中…";
  const result = await window.binance.exchangeInfo({
    symbol: getSelectedSymbol(), forceRefresh: true,
  });
  printResult("交易规则结果", result);
  elements.overviewStatus.textContent = result.ok ? "交易规则已加载" : formatError(result);
  if (result.ok) renderExchangeInfo(result.data);
});

document.querySelector("#refreshOverviewButton").addEventListener("click", async () => {
  elements.overviewStatus.textContent = "加载行情中…";
  const result = await window.binance.marketOverview({
    symbol: getSelectedSymbol(),
    interval: elements.klineInterval.value,
    limit: 50,
  });
  printResult("综合行情结果", result);
  elements.overviewStatus.textContent = result.ok ? "行情已加载" : formatError(result);
  if (result.ok) renderMarketOverview(result.data);
});

document.querySelector("#refreshOpenOrdersButton").addEventListener("click", async () => {
  elements.openOrdersStatus.textContent = "加载中…";
  const result = await refreshTrackedOpenOrders(getSelectedSymbol());
  printResult("当前挂单结果", result);
  if (result.ok) {
    elements.openOrdersStatus.textContent = `当前挂单 ${result.data?.length || 0} 条`;
  } else elements.openOrdersStatus.textContent = formatError(result);
});

document.querySelector("#cancelAllOpenOrdersButton").addEventListener("click", async () => {
  const symbol = getSelectedSymbol();
  if (!window.confirm(`确定撤销 ${symbol} 的全部当前挂单吗？`)) return;
  const result = await window.binance.cancelAllOpenOrders({ symbol });
  printResult("撤销全部挂单结果", result);
  elements.openOrdersStatus.textContent = result.ok ? `已撤销 ${result.data?.length || 0} 条` : formatError(result);
  if (result.ok) {
    for (const order of result.data || []) applyOpenOrderUpdate(order);
  }
});

document.querySelector("#queryOrderButton").addEventListener("click", async () => {
  const result = await window.binance.queryOrder({
    symbol: getSelectedSymbol(), orderId: elements.queryOrderId.value.trim(),
  });
  printResult("单笔订单结果", result);
  elements.queryOrderStatus.textContent = result.ok ? `状态：${result.data.status}` : formatError(result);
  if (result.ok) renderOrders([result.data], elements.queryOrderBody);
});

document.querySelector("#amendOrderButton").addEventListener("click", async () => {
  const result = await window.binance.amendOrder({
    symbol: getSelectedSymbol(), orderId: elements.queryOrderId.value.trim(),
    newQty: elements.amendOrderQty.value.trim(),
  });
  printResult("减量改单结果", result);
  elements.queryOrderStatus.textContent = result.ok ? "修改成功" : formatError(result);
});

document.querySelector("#cancelReplaceButton").addEventListener("click", async () => {
  const current = await window.binance.queryOrder({
    symbol: getSelectedSymbol(), orderId: elements.queryOrderId.value.trim(),
  });
  if (!current.ok) {
    printResult("撤单重报前查询失败", current);
    elements.queryOrderStatus.textContent = formatError(current);
    return;
  }
  const result = await window.binance.cancelReplace({
    cancelOrderId: current.data.orderId, symbol: current.data.symbol,
    side: current.data.side, type: "LIMIT", timeInForce: "GTC",
    quantity: elements.amendOrderQty.value.trim() || current.data.origQty,
    price: elements.replaceOrderPrice.value.trim(),
  });
  printResult("撤单并重报结果", result);
  elements.queryOrderStatus.textContent = result.ok ? "撤单重报完成" : formatError(result);
});

function synchronizeSymbolInput(symbol) {
  elements.chartSymbolInput.value = symbol;
}

async function connectMarketSymbol(rawSymbol, { showResult = true } = {}) {
  const symbol = String(rawSymbol || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{5,24}$/.test(symbol)) {
    const result = {
      ok: false,
      error: { message: "请输入有效的 Binance 交易对，例如 BTCUSDT。" },
    };
    elements.chartSymbolSwitchStatus.textContent = result.error.message;
    if (showResult) printResult("切换行情失败", result);
    return result;
  }

  elements.chartSymbolInput.value = symbol;
  elements.switchChartSymbolButton.disabled = true;
  elements.chartSymbolSwitchStatus.textContent = `正在验证：${symbol}`;

  try {
    const validation = await window.binance.exchangeInfo({ symbol });
    if (!validation.ok) {
      elements.chartSymbolSwitchStatus.textContent = formatError(validation);
      if (showResult) printResult("切换行情失败", validation);
      return validation;
    }

    synchronizeSymbolInput(symbol);
    const marketLabel = getMarketLabel(validation.data?.marketType);
    elements.chartSymbolSwitchStatus.textContent =
      `正在连接：${symbol} / ${marketLabel}`;
    elements.marketStatus.textContent = `connecting / ${symbol}`;
    const result = await window.binance.connectDepth(symbol);
    if (showResult) printResult("切换行情请求", result);
    if (!result.ok) {
      elements.chartSymbolSwitchStatus.textContent = formatError(result);
      return result;
    }

    elements.chartSymbolSwitchStatus.textContent =
      `连接中：${symbol} / ${marketLabel}`;
    refreshTrackedOpenOrders(symbol).catch((error) => {
      printResult("切换行情后同步挂单失败", {
        ok: false,
        error: { name: error.name, message: error.message },
      });
    });
    return result;
  } finally {
    elements.switchChartSymbolButton.disabled = false;
  }
}

document.querySelector("#connectMarketButton").addEventListener("click", () => {
  connectMarketSymbol(getSelectedSymbol());
});

elements.switchChartSymbolButton.addEventListener("click", () => {
  chart.data = [];
  connectMarketSymbol(elements.chartSymbolInput.value);
});

elements.chartSymbolInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  connectMarketSymbol(elements.chartSymbolInput.value);
});

document
  .querySelector("#disconnectMarketButton")
  .addEventListener("click", async () => {
    const result = await window.binance.disconnectMarket();
    printResult("断开行情", result);
  });

document
  .querySelector("#placeOrderButton")
  .addEventListener("click", async () => {
    const order = readOrderForm();
    const submittedAt = Date.now();
    const result = await submitOrderWithTradFiAgreement(order);
    printResult("下单结果", result);

    if (result.ok && result.data.orderId !== undefined) {
      elements.orderId.value = String(result.data.orderId);
      elements.queryOrderId.value = String(result.data.orderId);
      applyConfirmedOrderResponse(result.data, submittedAt);
    }
  });

document.querySelector("#testOrderButton").addEventListener("click", async () => {
  const result = await submitOrderWithTradFiAgreement(readOrderForm(), {
    testOnly: true,
  });
  printResult("测试下单结果（不会进入撮合引擎）", result);
});

document
  .querySelector("#cancelOrderButton")
  .addEventListener("click", async () => {
    const request = {
      symbol: getSelectedSymbol(),
      orderId: elements.orderId.value.trim(),
    };
    const result = await window.binance.cancelOrder(request);

    printResult("撤单结果", result);
    if (result.ok) applyOpenOrderUpdate(result.data);
  });

async function refreshOrderHistory(symbol, { showResult = true } = {}) {
  elements.refreshOrderHistoryButton.disabled = true;
  elements.orderHistoryStatus.textContent = "加载中…";

  try {
    const result = await window.binance.allOrders({
      symbol,
      limit: 100,
    });
    if (showResult) printResult("普通订单记录结果", result);

    if (!result.ok) {
      elements.orderHistoryStatus.textContent = formatError(result);
      return;
    }

    const orders = Array.isArray(result.data) ? result.data : [];
    renderOrders(orders);
    elements.orderHistoryStatus.textContent = `已加载 ${orders.length} 条 / ${new Date().toLocaleString()}`;
  } catch (error) {
    elements.orderHistoryStatus.textContent = error.message || "加载失败";
    printResult("读取普通订单记录异常", { message: error.message });
  } finally {
    elements.refreshOrderHistoryButton.disabled = false;
  }
}

elements.refreshOrderHistoryButton.addEventListener("click", () => {
  refreshOrderHistory(getSelectedSymbol());
});

async function refreshTradeHistory(symbol, { showResult = true } = {}) {
  elements.refreshTradeHistoryButton.disabled = true;
  elements.tradeHistoryStatus.textContent = "加载中…";

  try {
    const result = await window.binance.myTrades({
      symbol,
      limit: 100,
    });
    if (showResult) printResult("账户成交历史结果", result);

    if (!result.ok) {
      elements.tradeHistoryStatus.textContent = formatError(result);
      return;
    }

    const trades = Array.isArray(result.data) ? result.data : [];
    renderTrades(trades);
    elements.tradeHistoryStatus.textContent = `已加载 ${trades.length} 条 / ${new Date().toLocaleString()}`;
  } catch (error) {
    elements.tradeHistoryStatus.textContent = error.message || "加载失败";
    printResult("读取账户成交历史异常", { message: error.message });
  } finally {
    elements.refreshTradeHistoryButton.disabled = false;
  }
}

elements.refreshTradeHistoryButton.addEventListener("click", () => {
  refreshTradeHistory(getSelectedSymbol());
});

elements.refreshAccountButton.addEventListener("click", async () => {
  elements.refreshAccountButton.disabled = true;
  elements.accountStatus.textContent = "加载中…";

  try {
    const result = await window.binance.accountStatus({
      symbol: getSelectedSymbol(),
      omitZeroBalances: true,
    });
    printResult("账户信息结果", result);

    if (!result.ok) {
      elements.accountStatus.textContent = formatError(result);
      return;
    }

    renderAccountInfo(result.data || {});
    const balanceCount = Array.isArray(result.data?.balances)
      ? result.data.balances.filter(
          (balance) => Number(balance.locked) !== 0
        ).length
      : 0;
    elements.accountStatus.textContent = `已加载 / 锁定余额不为 0 的资产 ${balanceCount} 项 / ${new Date().toLocaleString()}`;
  } catch (error) {
    elements.accountStatus.textContent = error.message || "加载失败";
    printResult("读取账户信息异常", { message: error.message });
  } finally {
    elements.refreshAccountButton.disabled = false;
  }
});

elements.signTradFiAgreementButton.addEventListener("click", () => {
  signCurrentTradFiPerpsAgreement();
});

document.querySelector("#refreshCommissionButton").addEventListener("click", async () => {
  elements.riskStatus.textContent = "加载手续费率中…";
  const result = await window.binance.accountCommission({
    symbol: getSelectedSymbol(),
  });
  printResult("账户手续费率结果", result);
  if (!result.ok) {
    elements.riskStatus.textContent = formatError(result);
    return;
  }
  const data = result.data || {};
  renderRiskRows(Object.entries({
    标准费率: data.standardCommission,
    特殊费率: data.specialCommission,
    税费率: data.taxCommission,
  }).map(([name, rate]) => [name, rate?.maker, rate?.taker, rate?.buyer, rate?.seller]));
  elements.riskStatus.textContent = `${data.symbol || ""} 手续费率已加载`;
});

document.querySelector("#refreshRateLimitsButton").addEventListener("click", async () => {
  elements.riskStatus.textContent = "加载下单限频中…";
  const result = await window.binance.accountRateLimits({
    symbol: getSelectedSymbol(),
  });
  printResult("账户下单限频结果", result);
  if (!result.ok) {
    elements.riskStatus.textContent = formatError(result);
    return;
  }
  renderRiskRows((result.data || []).map((rate) => [
    `${rate.intervalNum} ${rate.interval}`, rate.limit, rate.count, "-", "-",
  ]));
  elements.riskStatus.textContent = "下单限频已加载";
});

function readOcoForm() {
  return {
    symbol: getSelectedSymbol(), side: elements.ocoSide.value,
    quantity: elements.ocoQuantity.value.trim(), workingPrice: elements.ocoWorkingPrice.value.trim(),
    abovePrice: elements.ocoAbovePrice.value.trim(), aboveStopPrice: elements.ocoAboveStopPrice.value.trim(),
    belowPrice: elements.ocoBelowPrice.value.trim(), belowStopPrice: elements.ocoBelowStopPrice.value.trim(),
  };
}

document.querySelector("#placeOcoButton").addEventListener("click", async () => {
  const result = await window.binance.placeOco(readOcoForm());
  printResult("创建 OCO 结果", result);
  elements.orderListsStatus.textContent = result.ok ? "OCO 创建成功" : formatError(result);
  if (result.ok) {
    elements.orderListId.value = result.data.orderListId ?? "";
    renderOrderLists(result.data);
  }
});

document.querySelector("#placeOtoButton").addEventListener("click", async () => {
  const form = readOcoForm();
  const result = await window.binance.placeOto({
    symbol: form.symbol,
    workingSide: form.side,
    workingPrice: form.workingPrice,
    workingQuantity: form.quantity,
    pendingSide: form.side === "BUY" ? "SELL" : "BUY",
    pendingPrice: form.belowPrice,
    pendingQuantity: form.quantity,
  });
  printResult("创建 OTO 结果", result);
  elements.orderListsStatus.textContent = result.ok ? "OTO 创建成功" : formatError(result);
  if (result.ok) {
    elements.orderListId.value = result.data.orderListId ?? "";
    renderOrderLists(result.data);
  }
});

document.querySelector("#placeOtocoButton").addEventListener("click", async () => {
  const form = readOcoForm();
  const result = await window.binance.placeOtoco({
    symbol: form.symbol,
    workingSide: form.side,
    workingPrice: form.workingPrice,
    workingQuantity: form.quantity,
    pendingSide: form.side === "BUY" ? "SELL" : "BUY",
    pendingQuantity: form.quantity,
    pendingAbovePrice: form.abovePrice,
    pendingBelowPrice: form.belowPrice,
    pendingBelowStopPrice: form.belowStopPrice,
  });
  printResult("创建 OTOCO 结果", result);
  elements.orderListsStatus.textContent = result.ok ? "OTOCO 创建成功" : formatError(result);
  if (result.ok) {
    elements.orderListId.value = result.data.orderListId ?? "";
    renderOrderLists(result.data);
  }
});

document.querySelector("#refreshAllOrderListsButton").addEventListener("click", async () => {
  const result = await window.binance.allOrderLists({
    symbol: getSelectedSymbol(), limit: 100,
  });
  printResult("组合订单历史结果", result);
  elements.orderListsStatus.textContent = result.ok ? `已加载 ${result.data?.length || 0} 条` : formatError(result);
  if (result.ok) renderOrderLists(result.data);
});

document.querySelector("#refreshOpenOrderListsButton").addEventListener("click", async () => {
  const result = await window.binance.openOrderLists({
    symbol: getSelectedSymbol(),
  });
  printResult("当前组合挂单结果", result);
  elements.orderListsStatus.textContent = result.ok ? `当前组合挂单 ${result.data?.length || 0} 条` : formatError(result);
  if (result.ok) renderOrderLists(result.data);
});

document.querySelector("#queryOrderListButton").addEventListener("click", async () => {
  const result = await window.binance.queryOrderList({
    symbol: getSelectedSymbol(), orderListId: elements.orderListId.value.trim(),
  });
  printResult("组合订单查询结果", result);
  elements.orderListsStatus.textContent = result.ok ? "组合订单已加载" : formatError(result);
  if (result.ok) renderOrderLists(result.data);
});

document.querySelector("#cancelOrderListButton").addEventListener("click", async () => {
  if (!window.confirm(`确定撤销组合订单 ${elements.orderListId.value.trim()} 吗？`)) return;
  const result = await window.binance.cancelOrderList({
    symbol: getSelectedSymbol(), orderListId: elements.orderListId.value.trim(),
  });
  printResult("撤销组合订单结果", result);
  elements.orderListsStatus.textContent = result.ok ? "组合订单已撤销" : formatError(result);
  if (result.ok) renderOrderLists(result.data);
});

document.querySelector("#connectUserDataButton").addEventListener("click", async () => {
  elements.userDataStatus.textContent = "连接中…";
  const result = await window.binance.connectUserData({
    symbol: getSelectedSymbol(),
  });
  printResult("连接实时账户事件", result);
  elements.userDataStatus.textContent = result.ok
    ? `已连接 / subscriptionId=${result.data.subscriptionId}`
    : formatError(result);
});

document.querySelector("#disconnectUserDataButton").addEventListener("click", async () => {
  const result = await window.binance.disconnectUserData();
  printResult("断开实时账户事件", result);
  elements.userDataStatus.textContent = result.ok ? "已断开" : formatError(result);
});

document.querySelector("#clearUserDataButton").addEventListener("click", () => {
  elements.userDataBody.replaceChildren();
  appendTextRow(elements.userDataBody, ["连接后等待账户事件"], 6);
});

elements.orderType.addEventListener("change", () => {
  const type = elements.orderType.value;
  const needsPrice = ["LIMIT", "LIMIT_MAKER", "STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT"].includes(type);
  const needsStop = type.includes("STOP") || type.includes("TAKE_PROFIT");
  const supportsIceberg = ["LIMIT", "STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT"].includes(type);
  elements.price.disabled = !needsPrice;
  elements.stopPrice.disabled = !needsStop;
  elements.trailingDelta.disabled = !needsStop;
  elements.icebergQty.disabled = !supportsIceberg;
});
const chartDom = document.querySelector('#can');
const mousebar= document.querySelector("#mousebar")
mousebar.style.width = '13px'
let left = 0;
const chart = new Chart(chartDom,980, 300, 0.01,{
    volumeScaleCount: 3,
    volumeScaleHeight: 25,
    volumeScaleTick: 10,
    volumeScaleType: 2,
    volumeXOffset: 2,
    volumeYOffset: 0,
    barLevel: 4,
    barToBorder: 10,
    barVolume: 140,
    barWidth: 13,
    calcBarType: 2

});
chartDom.addEventListener('mousemove', function(e){
   const {x ,y} = e;
      
    if(x > 122  && x < 13 * chart.count + 124   && y > 370 && y < 590){
      left = x - (x-123)%13 - 24;
      
      mousebar.style.display = 'block';
      mousebar.style.left = left+'px'
    }else {
      mousebar.style.display = 'none';
      left = 0
    }
})
document.addEventListener('dblclick', async function(){
  debugger
  if(left){
     const index = (left - 123 + 24) / 13
     let side 
     let {buyIndex, askIndex, start} = chart;
     if(index <= buyIndex){
      side = 'BUY';
     }else if(index >= askIndex){
      side = 'SELL';
     }else{
      return
     }
     const price = chart.data[index- start].price;
      const order = {
        symbol: getSelectedSymbol(),
        side,
        type: 'LIMIT',
        price,
        stopPrice: '',
        trailingDelta: '',
        icebergQty: '',
        timeInForce: "GTC" ,
        quantity: '0.1'
      };
       const submittedAt = Date.now();
      const result = await submitOrderWithTradFiAgreement(order);
      printResult("下单结果", result);

      if (result.ok && result.data.orderId !== undefined) {
        elements.orderId.value = String(result.data.orderId);
        elements.queryOrderId.value = String(result.data.orderId);
        applyConfirmedOrderResponse(result.data, submittedAt);
      }
  }
})
const SHORTCUT_STORAGE_KEY = "binanceShortcutSettingsV2";
const LEGACY_SHORTCUT_STORAGE_KEY = "binanceShortcutSettingsV1";
const COLORBLIND_STORAGE_KEY = "binanceColorblindModeV1";
const shortcutApi = window.ShortcutSettings;
const shortcutDialog = document.querySelector("#shortcutDialog");
const shortcutEditorDialog = document.querySelector("#shortcutEditorDialog");
const shortcutEditorForm = document.querySelector("#shortcutEditorForm");
const shortcutEditorTitle = document.querySelector("#shortcutEditorTitle");
const shortcutEditorFields = {
  key: document.querySelector("#shortcutEditorKey"),
  action: document.querySelector("#shortcutEditorAction"),
  direction: document.querySelector("#shortcutEditorDirection"),
  priceOffset: document.querySelector("#shortcutEditorPriceOffset"),
  quantity: document.querySelector("#shortcutEditorQuantity"),
  amountLabel: document.querySelector("#shortcutEditorAmountLabel"),
};
let shortcutSettings = shortcutApi.cloneDefaults();
let editingShortcutId = null;
let shortcutEditorMode = "edit";
let colorblindMode = loadBooleanSetting(COLORBLIND_STORAGE_KEY);

function loadBooleanSetting(key) {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function loadLegacyShortcutSettings() {
  try {
    const storedText = localStorage.getItem(SHORTCUT_STORAGE_KEY);
    if (storedText !== null) {
      const result = shortcutApi.validate(JSON.parse(storedText));
      if (result.valid) return result.settings;
    }

    const legacyText = localStorage.getItem(LEGACY_SHORTCUT_STORAGE_KEY);
    const legacySettings = legacyText ? JSON.parse(legacyText) : null;
    const migrated = shortcutApi.validate(
      shortcutApi.migrateLegacySettings(legacySettings)
    );
    if (migrated.valid) return migrated.settings;
  } catch {
    // 旧版 localStorage 无效时由主进程创建默认 JSON 配置。
  }
  return null;
}

async function initializeShortcutSettings() {
  const result = await window.binance.loadShortcutSettings(
    loadLegacyShortcutSettings()
  );
  if (!result.ok) {
    shortcutSettings = shortcutApi.cloneDefaults();
    updateShortcutSummary();
    printResult("读取快捷键配置失败", result);
    return;
  }

  shortcutSettings = result.data.settings;
  updateShortcutSummary();
}

async function saveShortcutSettings(settings) {
  const result = await window.binance.saveShortcutSettings(settings);
  if (!result.ok) {
    printResult("保存快捷键配置失败", result);
    return null;
  }
  return result.data.settings;
}

function updateShortcutSummary() {
  const descriptions = shortcutSettings.map((shortcut) => {
    const key = shortcutApi.getKeyLabel(shortcut.key);
    if (shortcut.action === shortcutApi.ACTION_CANCEL_ALL) {
      return `${key} = 撤销全部未成交订单`;
    }
    const amount = shortcut.action === shortcutApi.ACTION_ORDER_QUOTE_TOTAL
      ? `总价 ${shortcut.quoteOrderQty}`
      : `手数 ${shortcut.quantity}`;
    return [
      `${key} = ${shortcutApi.getActionLabel(shortcut.action)}` +
        ` / 方向 ${shortcutApi.getDirectionLabel(shortcut.direction)}`,
      `超价 ${shortcutApi.formatPriceOffset(shortcut.priceOffset)}`,
      amount,
    ].join(" / ");
  });
  document.querySelector("#shortcutSummary").textContent =
    descriptions.length ? `快捷键：${descriptions.join("，")}。` : "快捷键：当前没有已启用规则。";
}

function appendShortcutCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = value;
  row.append(cell);
  return cell;
}

function renderShortcutTable() {
  const body = document.querySelector("#shortcutTableBody");
  body.replaceChildren();
  if (!shortcutSettings.length) {
    const row = document.createElement("tr");
    const cell = appendShortcutCell(row, "当前没有快捷键，点击“恢复默认”可重新创建默认规则。");
    cell.colSpan = 6;
    cell.className = "shortcut-empty";
    body.append(row);
    return;
  }

  for (const shortcut of shortcutSettings) {
    const isOrder = shortcutApi.isOrderAction(shortcut.action);
    const isQuoteTotal =
      shortcut.action === shortcutApi.ACTION_ORDER_QUOTE_TOTAL;
    const row = document.createElement("tr");
    appendShortcutCell(row, shortcutApi.getKeyLabel(shortcut.key));
    appendShortcutCell(row, shortcutApi.getActionLabel(shortcut.action));
    appendShortcutCell(
      row,
      isOrder ? shortcutApi.getDirectionLabel(shortcut.direction) : "-"
    );
    appendShortcutCell(
      row,
      isOrder ? shortcutApi.formatPriceOffset(shortcut.priceOffset) : "-"
    );
    appendShortcutCell(
      row,
      isOrder
        ? (isQuoteTotal ? `${shortcut.quoteOrderQty}（总价）` : shortcut.quantity)
        : "-"
    );

    const operationCell = document.createElement("td");
    operationCell.className = "shortcut-operation";
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.textContent = "编辑";
    editButton.addEventListener("click", () => openShortcutEditor(shortcut.id));
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger";
    deleteButton.textContent = "删除";
    deleteButton.addEventListener("click", () => deleteShortcut(shortcut.id));
    operationCell.append(editButton, deleteButton);
    row.append(operationCell);
    body.append(row);
  }
}

function updateShortcutEditorFields() {
  const action = shortcutEditorFields.action.value;
  const isOrder = shortcutApi.isOrderAction(action);
  const isQuoteTotal = action === shortcutApi.ACTION_ORDER_QUOTE_TOTAL;
  shortcutEditorFields.direction.disabled = !isOrder;
  shortcutEditorFields.priceOffset.disabled = !isOrder;
  shortcutEditorFields.quantity.disabled = !isOrder;
  shortcutEditorFields.amountLabel.textContent = isQuoteTotal ? "总价" : "手数";
  shortcutEditorFields.quantity.placeholder = isQuoteTotal
    ? "计价资产名义金额，例如 100 USDT"
    : "交易数量，例如 0.001";
}

function populateShortcutEditor(shortcut) {
  shortcutEditorFields.key.value = shortcut.key;
  shortcutEditorFields.action.value = shortcut.action;
  shortcutEditorFields.direction.value =
    shortcut.direction || shortcutApi.DIRECTION_SHORT;
  shortcutEditorFields.priceOffset.value = shortcut.priceOffset ?? "";
  shortcutEditorFields.quantity.value =
    shortcut.action === shortcutApi.ACTION_ORDER_QUOTE_TOTAL
      ? shortcut.quoteOrderQty || ""
      : shortcut.quantity || "";
  document.querySelector("#shortcutEditorError").textContent = "";
  updateShortcutEditorFields();
}

function openShortcutCreator() {
  const usedKeys = new Set(shortcutSettings.map(({ key }) => key));
  const availableKey = shortcutApi.AVAILABLE_KEYS.find(
    ({ code }) => !usedKeys.has(code)
  );
  if (!availableKey) {
    window.alert("小键盘 0–9 均已配置，请先删除或修改一个现有快捷键。");
    return;
  }

  shortcutEditorMode = "create";
  editingShortcutId = null;
  shortcutEditorTitle.textContent = "快捷键新增窗口";
  populateShortcutEditor({
    key: availableKey.code,
    action: shortcutApi.ACTION_ORDER,
    direction: shortcutApi.DIRECTION_SHORT,
    priceOffset: 0.1,
    quantity: "0.001",
  });
  shortcutEditorDialog.showModal();
}

function openShortcutEditor(shortcutId) {
  const shortcut = shortcutSettings.find(({ id }) => id === shortcutId);
  if (!shortcut) return;
  shortcutEditorMode = "edit";
  editingShortcutId = shortcutId;
  shortcutEditorTitle.textContent = "快捷键编辑窗口";
  populateShortcutEditor(shortcut);
  shortcutEditorDialog.showModal();
}

async function deleteShortcut(shortcutId) {
  const deleted = shortcutSettings.find(({ id }) => id === shortcutId);
  const candidate = shortcutSettings.filter(({ id }) => id !== shortcutId);
  const savedSettings = await saveShortcutSettings(candidate);
  if (!savedSettings) return;
  shortcutSettings = savedSettings;
  renderShortcutTable();
  updateShortcutSummary();
  printResult("快捷键已删除", {
    ok: true,
    data: deleted
      ? { shortcut: shortcutApi.getKeyLabel(deleted.key) }
      : { shortcutId },
  });
}

function closeTitleMenus(except = null) {
  for (const menu of document.querySelectorAll("[data-title-menu]")) {
    if (menu !== except) menu.open = false;
  }
}

for (const { code, label } of shortcutApi.AVAILABLE_KEYS) {
  const option = document.createElement("option");
  option.value = code;
  option.textContent = label;
  shortcutEditorFields.key.append(option);
}

for (const menu of document.querySelectorAll("[data-title-menu]")) {
  menu.addEventListener("toggle", () => {
    if (menu.open) closeTitleMenus(menu);
  });
}

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("[data-title-menu]")) closeTitleMenus();
});

document.querySelector("#openThreeInstancesMenuItem").addEventListener("click", async () => {
  closeTitleMenus();
  const result = await window.binance.openAdditionalInstances(2);
  printResult("打开另外两份程序", result);
});

document.querySelector("#reloadMenuItem").addEventListener("click", () => {
  closeTitleMenus();
  window.location.reload();
});

document.querySelector("#aboutMenuItem").addEventListener("click", () => {
  closeTitleMenus();
  window.alert("Binance 统一交易测试台\n支持自动识别 Spot / USDⓈ-M、Testnet / 正式环境、行情展示和快捷交易。" );
});

document.querySelector("#shortcutMenuItem").addEventListener("click", () => {
  closeTitleMenus();
  renderShortcutTable();
  shortcutDialog.showModal();
});

document.querySelector("#addShortcutButton").addEventListener("click", () => {
  openShortcutCreator();
});

document.querySelector("#contractReminderMenuItem").addEventListener("click", () => {
  closeTitleMenus();
  window.alert("“提醒合约参数”配置入口已建立，具体提醒参数可在后续继续补充。" );
});

document.querySelector("#resetShortcutsButton").addEventListener("click", async () => {
  const savedSettings = await saveShortcutSettings(shortcutApi.cloneDefaults());
  if (!savedSettings) return;
  shortcutSettings = savedSettings;
  renderShortcutTable();
  updateShortcutSummary();
  printResult("快捷键已恢复默认", { ok: true, data: shortcutSettings });
});

document.querySelector("#closeShortcutsButton").addEventListener("click", () => {
  shortcutDialog.close();
});

shortcutEditorFields.action.addEventListener("change", updateShortcutEditorFields);

document.querySelector("#cancelShortcutEditorButton").addEventListener("click", () => {
  shortcutEditorDialog.close();
});

shortcutEditorForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const isCreating = shortcutEditorMode === "create";
  const existing = isCreating
    ? null
    : shortcutSettings.find(({ id }) => id === editingShortcutId);
  if (!isCreating && !existing) {
    shortcutEditorDialog.close();
    return;
  }

  const action = shortcutEditorFields.action.value;
  const isOrder = shortcutApi.isOrderAction(action);
  const isQuoteTotal = action === shortcutApi.ACTION_ORDER_QUOTE_TOTAL;
  const priceOffsetText = shortcutEditorFields.priceOffset.value.trim();
  const amountText = shortcutEditorFields.quantity.value.trim();
  let createdId = `shortcut-${Date.now()}`;
  let suffix = 1;
  while (shortcutSettings.some(({ id }) => id === createdId)) {
    createdId = `shortcut-${Date.now()}-${suffix}`;
    suffix += 1;
  }
  const edited = {
    ...(existing || { id: createdId }),
    key: shortcutEditorFields.key.value,
    action,
    direction: isOrder
      ? shortcutEditorFields.direction.value
      : "",
    priceOffset: isOrder
      ? (priceOffsetText === "" ? Number.NaN : Number(priceOffsetText))
      : null,
    quantity: action === shortcutApi.ACTION_ORDER ? amountText : "",
    quoteOrderQty: isQuoteTotal ? amountText : "",
  };
  const candidate = isCreating
    ? [...shortcutSettings, edited]
    : shortcutSettings.map((shortcut) =>
      shortcut.id === editingShortcutId ? edited : shortcut
    );
  const result = shortcutApi.validate(candidate);
  if (!result.valid) {
    document.querySelector("#shortcutEditorError").textContent =
      result.errors.join(" ");
    return;
  }

  const savedSettings = await saveShortcutSettings(result.settings);
  if (!savedSettings) return;
  shortcutSettings = savedSettings;
  const savedShortcut = shortcutSettings.find(({ id }) => id === edited.id);
  renderShortcutTable();
  updateShortcutSummary();
  shortcutEditorDialog.close();
  printResult(isCreating ? "快捷键已新增" : "快捷键设置已保存", {
    ok: true,
    data: savedShortcut,
  });
});

shortcutEditorDialog.addEventListener("close", () => {
  editingShortcutId = null;
  shortcutEditorMode = "edit";
  shortcutEditorTitle.textContent = "快捷键编辑窗口";
  document.querySelector("#shortcutEditorError").textContent = "";
});

function applyColorblindMode(enabled, { persist = true } = {}) {
  colorblindMode = Boolean(enabled);
  document.body.classList.toggle("colorblind-mode", colorblindMode);
  const menuItem = document.querySelector("#colorblindMenuItem");
  menuItem.setAttribute("aria-checked", String(colorblindMode));
  document.querySelector("#colorblindMenuState").textContent =
    colorblindMode ? "已开启" : "未开启";
  chart.setColor(colorblindMode);
  if (chart.args?.LastPrice && chart.data.length) chart.render(chart.args);

  if (persist) {
    try {
      localStorage.setItem(COLORBLIND_STORAGE_KEY, String(colorblindMode));
    } catch {
      // 外观设置保存失败不影响当前会话。
    }
  }
}

document.querySelector("#colorblindMenuItem").addEventListener("click", () => {
  closeTitleMenus();
  applyColorblindMode(!colorblindMode);
});

updateShortcutSummary();
applyColorblindMode(colorblindMode, { persist: false });
let resizeTimeout;
    window.onresize = (event) => {
        const width = Math.max(240, event.target.innerWidth - 80);
        chartDom.width = width;
        chartDom.style.width = `${width}px`;
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            chart.resize(width, 300);
            if (chart.args?.LastPrice && chart.data.length) {
                chart.render(chart.args);
            }
        }, 200);
    }
let chartSymbol = null;
let chartMarketType = null;
const latestTradePrices = new Map();
const openOrdersByKey = new Map();
const executionReportStatusByClientId = new Map();
let numpadOrderBusy = false;
let executionReportRefreshTimer = null;

function offsetTradePrice(price, offset) {
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice)) return null;
  const decimals = Math.min(12, Math.max(
    (String(price).split(".")[1] || "").length,
    (String(offset).split(".")[1] || "").length,
    1
  ));
  return (numericPrice + offset).toFixed(decimals);
}

function applyConfirmedOrderResponse(order, submittedAt) {
  const clientOrderId = String(order?.clientOrderId || "");
  const report = clientOrderId
    ? executionReportStatusByClientId.get(clientOrderId)
    : null;

  // executionReport 已经是 Binance 的更新结果时，不再用较旧的报单响应覆盖它。
  if (report && report.receivedAt >= submittedAt) return;
  applyOpenOrderUpdate(order);
}

async function placeOrderFromNumpad(shortcut) {
  const symbol = getSelectedSymbol();
  const latestPrice = latestTradePrices.get(symbol);
  const side = shortcut.direction === shortcutApi.DIRECTION_SHORT
    ? "SELL"
    : "BUY";
  const price = offsetTradePrice(latestPrice, shortcut.priceOffset);
  const shortcutLabel = shortcutApi.getKeyLabel(shortcut.key);
  const quoteTotalMode =
    shortcut.action === shortcutApi.ACTION_ORDER_QUOTE_TOTAL;

  if (!latestPrice || !price || Number(price) <= 0) {
    printResult(`${shortcutLabel} 快捷键报单失败`, {
      ok: false,
      error: { message: `${symbol || "当前交易对"} 尚未收到最新成交价。` },
    });
    return;
  }

  elements.side.value = side;
  elements.orderType.value = "LIMIT";
  elements.orderSizingMode.value = quoteTotalMode ? "quote-total" : "quantity";
  updateOrderSizingFields();
  if (quoteTotalMode) {
    elements.quoteOrderQty.value = shortcut.quoteOrderQty;
  } else {
  elements.quantity.value = shortcut.quantity;
  }
  elements.price.value = price;

  const order = {
    symbol,
    side,
    type: "LIMIT",
    price,
    timeInForce: "GTC",
    ...(quoteTotalMode
      ? { quoteOrderQty: shortcut.quoteOrderQty }
      : { quantity: shortcut.quantity }),
  };
  const submittedAt = Date.now();
  const result = await submitOrderWithTradFiAgreement(order);
  printResult(
    `${shortcutLabel} ${shortcutApi.getActionLabel(shortcut.action)}` +
      `（${shortcutApi.getDirectionLabel(shortcut.direction)}）结果`,
    result
  );

  if (result.ok) {
    elements.orderId.value = String(result.data.orderId ?? "");
    elements.queryOrderId.value = String(result.data.orderId ?? "");
    applyConfirmedOrderResponse(result.data, submittedAt);
  }
}

async function cancelAllOpenOrdersFromNumpad(shortcut) {
  const shortcutLabel = shortcutApi.getKeyLabel(shortcut.key);
  const openResult = await window.binance.openOrders({});
  if (!openResult.ok) {
    printResult(`${shortcutLabel} 查询全部未成交订单失败`, openResult);
    return;
  }

  const targets = [...new Map(
    (openResult.data || [])
      .map((order) => ({
        symbol: String(order.symbol || "").toUpperCase(),
        marketType: order.marketType,
      }))
      .filter((target) => target.symbol)
      .map((target) => [`${target.marketType || "auto"}:${target.symbol}`, target])
  ).values()];
  if (!targets.length) {
    printResult(`${shortcutLabel} 撤销全部未成交订单`, {
      ok: true,
      data: { canceledOrderCount: 0, symbols: [] },
    });
    return;
  }

  const cancellations = [];
  for (const target of targets) {
    const result = await window.binance.cancelAllOpenOrders(target);
    cancellations.push({ ...target, ...result });
    if (result.ok) {
      for (const order of result.data || []) applyOpenOrderUpdate(order);
    }
  }

  const failed = cancellations.filter((result) => !result.ok);
  printResult(`${shortcutLabel} 撤销全部未成交订单结果`, {
    ok: failed.length === 0,
    data: {
      symbols: targets.map((target) => target.symbol),
      canceledOrderCount: cancellations.reduce(
        (count, result) => count + (Array.isArray(result.data) ? result.data.length : 0),
        0
      ),
      cancellations,
    },
    ...(failed.length ? { error: { message: `${failed.length} 个交易对撤单失败。` } } : {}),
  });
}

document.addEventListener("keydown", async (event) => {
  const shortcutDialogOpen = shortcutDialog.open || shortcutEditorDialog.open;
  const editingTarget = event.target instanceof Element && Boolean(
    event.target.closest("input, select, textarea, button, [contenteditable='true']")
  );
  const shortcut = shortcutApi.getShortcutForCode(event.code, shortcutSettings);
  if (event.repeat || event.ctrlKey || event.altKey || event.metaKey ||
      event.shiftKey || shortcutDialogOpen || editingTarget || !shortcut) {
    return;
  }

  event.preventDefault();
  if (numpadOrderBusy) {
    printResult("小键盘订单操作", {
      ok: false,
      error: { message: "上一笔小键盘订单操作尚未完成，请稍候。" },
    });
    return;
  }

  numpadOrderBusy = true;
  try {
    if (shortcutApi.isOrderAction(shortcut.action)) {
      await placeOrderFromNumpad(shortcut);
    }
    if (shortcut.action === shortcutApi.ACTION_CANCEL_ALL) {
      await cancelAllOpenOrdersFromNumpad(shortcut);
    }
  } catch (error) {
    printResult("小键盘订单操作异常", {
      ok: false,
      error: { name: error.name, message: error.message },
    });
  } finally {
    numpadOrderBusy = false;
  }
});

function scheduleExecutionReportRefresh() {
  clearTimeout(executionReportRefreshTimer);
  executionReportRefreshTimer = setTimeout(() => {
    const symbol = getSelectedSymbol();
    if (!symbol) return;
    Promise.all([
      refreshOrderHistory(symbol, { showResult: false }),
      refreshTradeHistory(symbol, { showResult: false }),
    ]).catch((error) => {
      printResult("账户事件自动刷新异常", {
        ok: false,
        error: { name: error.name, message: error.message },
      });
    });
  }, 250);
}

function openOrderKey(order) {
  return `${order.marketType || "auto"}:${order.symbol}:${order.orderId}`;
}

function normalizeOpenOrder(order, receivedAt = Date.now()) {
  const normalized = {
    marketType: order.marketType || null,
    symbol: String(order.symbol ?? order.s ?? "").toUpperCase(),
    orderId: order.orderId ?? order.i,
    clientOrderId: order.clientOrderId ?? order.c ?? order.newClientOrderId ?? "",
    side: String(order.side ?? order.S ?? "").toUpperCase(),
    type: String(order.type ?? order.o ?? "").toUpperCase(),
    status: String(order.status ?? order.X ?? "").toUpperCase(),
    price: String(order.price ?? order.p ?? "0"),
    stopPrice: String(order.stopPrice ?? order.P ?? "0"),
    origQty: String(order.origQty ?? order.q ?? "0"),
    executedQty: String(order.executedQty ?? order.z ?? "0"),
    updateTime: Number(order.updateTime ?? order.T ?? order.E ?? Date.now()),
    receivedAt,
  };

  return normalized.symbol && normalized.orderId !== undefined
    ? normalized
    : null;
}

function isOpenOrder(order) {
  return ["NEW", "PARTIALLY_FILLED"].includes(order.status) &&
    Number(order.origQty) - Number(order.executedQty) > 0;
}

function updateChartOrderStatus() {
  const total = chart.totalPlaceOrderCount ?? chart.placeOrder.length;
  const visible = chart.visiblePlaceOrderCount ?? 0;
  elements.chartOpenOrderStatus.innerHTML =
    `<span class="open-order">鲜红色柱：自有未成交挂单</span>，` +
    `图内 ${visible} 个价位 / 共 ${total} 个价位（柱高为剩余数量）`;
}

function syncTrackedOpenOrders() {
  const symbol = getSelectedSymbol();
  const orders = [...openOrdersByKey.values()]
    .filter((order) =>
      order.symbol === symbol &&
      (!chartMarketType || !order.marketType || order.marketType === chartMarketType) &&
      isOpenOrder(order)
    );

  chart.placeOrder = orders;
  chart.totalPlaceOrderCount = orders.length;

  const tableOrders = [...openOrdersByKey.values()]
    .filter((order) =>
      order.symbol === symbol &&
      (!chartMarketType || !order.marketType || order.marketType === chartMarketType) &&
      isOpenOrder(order)
    );
  renderOrders(tableOrders, elements.openOrdersBody);
  elements.openOrdersStatus.textContent = `实时未成交 ${tableOrders.length} 笔`;
  updateChartOrderStatus();

  // 不等待下一帧深度推送，订单状态变化后立即重绘当前行情画布。
  if (chart.args?.LastPrice && chart.data.length) {
    try {
      chart.render(chart.args);
    } catch (error) {
      printResult("挂单即时绘制错误", {
        ok: false,
        error: { name: error.name, message: error.message },
      });
    }
  }
}

function applyOpenOrderUpdate(order, receivedAt = Date.now()) {
  const normalized = normalizeOpenOrder(order, receivedAt);
  if (!normalized) return;

  const key = openOrderKey(normalized);
  const existing = openOrdersByKey.get(key);
  if (existing && existing.receivedAt > normalized.receivedAt) return;

  if (isOpenOrder(normalized)) openOrdersByKey.set(key, normalized);
  else openOrdersByKey.delete(key);
  syncTrackedOpenOrders();
}

async function refreshTrackedOpenOrders(symbol = getSelectedSymbol()) {
  const normalizedSymbol = String(symbol || "").trim().toUpperCase();
  const snapshotStartedAt = Date.now();
  const result = await window.binance.openOrders({ symbol: normalizedSymbol });
  if (!result.ok) return result;

  for (const [key, order] of openOrdersByKey) {
    if (
      order.symbol === normalizedSymbol &&
      (!chartMarketType || !order.marketType || order.marketType === chartMarketType) &&
      order.receivedAt <= snapshotStartedAt
    ) {
      openOrdersByKey.delete(key);
    }
  }
  for (const order of result.data || []) {
    const normalized = normalizeOpenOrder(order, snapshotStartedAt);
    if (normalized && isOpenOrder(normalized)) {
      openOrdersByKey.set(openOrderKey(normalized), normalized);
    }
  }
  syncTrackedOpenOrders();
  return result;
}

function fillLatestTradePrice() {
  const symbol = getSelectedSymbol();
  const price = latestTradePrices.get(symbol);

  if (elements.latestTradePriceToggle.checked && price) {
    elements.price.value = price;
  }
}

elements.latestTradePriceToggle.addEventListener("change", () => {
  elements.latestTradePriceState.textContent = elements.latestTradePriceToggle.checked
    ? "选中"
    : "未选中";
  fillLatestTradePrice();
});

elements.chartSymbolInput.addEventListener("change", fillLatestTradePrice);

window.binance.onTradeUpdate((trade) => {
  const symbol = String(trade.symbol || "").toUpperCase();
  const price = String(trade.price || "");

  if (symbol && price && Number.isFinite(Number(price))) {
    latestTradePrices.set(symbol, price);
    fillLatestTradePrice();
  }
});

function createChartDepthData(depth) {
  const data = {};
  const sides = [
    ["Bid", depth.bids],
    ["Ask", depth.asks],
  ];

  for (const [side, levels] of sides) {
    for (const [index, level] of (levels || []).slice(0, 5).entries()) {
      const price = Number(level.price);
      const volume = Number(level.quantity);

      if (Number.isFinite(price) && Number.isFinite(volume)) {
        data[`${side}Price${index + 1}`] = price;
        data[`${side}Volume${index + 1}`] = volume;
      }
    }
  }

  data.LastPrice = data.AskPrice1 || data.BidPrice1;
  return data;
}

window.binance.onDepthUpdate((depth) => {
  renderDepthRows(elements.bidRows, depth.bids || []);
  renderDepthRows(elements.askRows, depth.asks || []);

  const bestBid = depth.bids?.[0]?.price;
  const bestAsk = depth.asks?.[0]?.price;
  const spread =
    bestBid && bestAsk ? Number(bestAsk) - Number(bestBid) : null;

  elements.lastUpdateId.textContent = depth.lastUpdateId ?? "-";
  elements.receivedAt.textContent = new Date(
    depth.receivedAt
  ).toLocaleString();
  elements.spread.textContent =
    spread === null || !Number.isFinite(spread)
      ? "-"
      : String(spread);

  if (depth.marketType) chartMarketType = depth.marketType;
  if (depth.symbol && chartSymbol !== depth.symbol) {
    chart.reset();
    chartSymbol = depth.symbol;
    syncTrackedOpenOrders();
  }

  try {
    chart.render(createChartDepthData(depth));
    updateChartOrderStatus();
  } catch (error) {
    printResult("行情图表渲染错误", {
      ok: false,
      error: {
        name: error.name,
        message: error.message,
      },
    });
  }
});

window.binance.onMarketStatus((status) => {
  const marketLabel = getMarketLabel(status.marketType);
  if (status.symbol && status.marketType) chartMarketType = status.marketType;
  elements.marketStatus.textContent = [
    status.status,
    status.symbol || "",
    status.symbol ? marketLabel : "",
    status.lastUpdateId !== undefined
      ? `updateId=${status.lastUpdateId}`
      : "",
    status.code !== undefined ? `code=${status.code}` : "",
  ]
    .filter(Boolean)
    .join(" / ");
  if (status.symbol) {
    elements.chartSymbolSwitchStatus.textContent =
      status.status === "connected"
        ? `当前：${status.symbol} / ${marketLabel}`
        : `${status.status}：${status.symbol} / ${marketLabel}`;
  }
});

window.binance.onMarketError((error) => {
  if (!error.symbol || error.symbol === elements.chartSymbolInput.value.trim().toUpperCase()) {
    elements.chartSymbolSwitchStatus.textContent =
      `${error.symbol || "行情"}：${error.message || "连接失败"}`;
  }
  printResult("行情连接错误", error);
});

window.binance.onUserDataEvent((payload) => {
  prependUserDataEvent(payload);
  if (payload.event?.e === "executionReport") {
    const routedEvent = {
      ...payload.event,
      marketType: payload.marketType || payload.event.marketType,
    };
    const clientOrderId = String(payload.event.c || "");
    if (clientOrderId) {
      executionReportStatusByClientId.set(clientOrderId, {
        status: String(payload.event.X || payload.event.x || ""),
        receivedAt: Number(payload.receivedAt || Date.now()),
      });
      if (executionReportStatusByClientId.size > 1_000) {
        executionReportStatusByClientId.delete(
          executionReportStatusByClientId.keys().next().value
        );
      }
    }
    applyOpenOrderUpdate(routedEvent, payload.receivedAt);
    scheduleExecutionReportRefresh(payload.event);
  }
});

window.binance.onUserDataStatus((status) => {
  elements.userDataStatus.textContent = [
    status.status,
    getMarketLabel(status.marketType),
    status.subscriptionId !== undefined ? `subscriptionId=${status.subscriptionId}` : "",
    status.code !== undefined ? `code=${status.code}` : "",
  ].filter(Boolean).join(" / ");

  if (status.status === "connected") {
    refreshTrackedOpenOrders().catch((error) => {
      printResult("同步当前挂单失败", { ok: false, error: { message: error.message } });
    });
  }
});

window.binance.onUserDataError((error) => {
  printResult("实时账户事件错误", error);
  if (requiresTradFiPerpsAgreement({ ok: false, error })) {
    signCurrentTradFiPerpsAgreement().then((result) => {
      if (!result?.ok) return;
      window.binance.connectUserData({
        symbol: getSelectedSymbol(),
      }).then((reconnectResult) => {
        printResult("签署协议后重新连接实时账户事件", reconnectResult);
      }).catch((reconnectError) => {
        printResult("签署协议后重连实时账户事件异常", {
          ok: false,
          error: {
            name: reconnectError?.name || "Error",
            message: reconnectError?.message || "重连失败",
          },
        });
      });
    });
  }
});

async function initializeApp() {
  await initializeShortcutSettings();
  await loadStatus();

  const switchResultText = sessionStorage.getItem(
    "binanceEnvironmentSwitchResult"
  );
  if (switchResultText) {
    sessionStorage.removeItem("binanceEnvironmentSwitchResult");
    try {
      const switchResult = JSON.parse(switchResultText);
      printResult("切换 Binance 环境完成", switchResult);
    } catch {
      // 页面重载后的提示不是核心状态，解析失败时直接忽略。
    }
  }

  const symbol = elements.chartSymbolInput.value.trim().toUpperCase();
  const result = await connectMarketSymbol(symbol, { showResult: false });

  if (!result.ok) {
    printResult("自动连接增量深度失败", result);
  }
}

initializeApp().catch((error) => {
  printResult("初始化异常", {
    message: error.message,
  });
});
